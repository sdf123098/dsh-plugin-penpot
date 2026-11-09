/**
 * 迁移：把别的 MCP 客户端里的 penpot 条目搬进本插件，可选就地停用。
 *
 * 三条硬规则（都有实测依据，见 README「鉴权真相」）：
 *   1. **绝不把 MCP key 写成 Bearer**。Penpot 服务端忽略 Authorization 头，
 *      只认 URL 里的 `?userToken=`；所以任何带 token 的形状迁移时都回写成
 *      查询参数（token 单独存进本插件的配置层，URL 里只留脱敏前的干净地址）。
 *   2. **绝不按「Auth=OAuth」筛**。Codex 里 Auth=OAuth 的是 hyperframes，
 *      不是 penpot；按那个筛会误伤别人的服务器。
 *   3. **先备份再动手**。每条改动都留 before/after 原文进 backups/<时间戳>/，
 *      manifest 记清楚改了什么，面板可一键还原。
 *
 * 默认动作是「只导入」（不动别人的配置）；「导入 + 就地停用」要用户明确勾选。
 *
 * @module dsh-plugin-penpot/migrate
 */

import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  backupFile,
  createBackupDir,
  listBackups,
  readBackupManifest,
  writeBackupManifest,
} from './store.js'
import {
  commentYamlEntry,
  disableJsonServer,
  disableTomlServer,
} from './formats.js'
import { scanAll } from './detect.js'

/** 三种动作。 */
export const ACTIONS = ['import-only', 'import-and-disable', 'export-snippet']

/**
 * 一条候选 → 本插件配置的补丁。
 *
 * @param {import('./detect.js').Candidate} candidate
 * @returns {Record<string, unknown>}
 */
export function patchForCandidate(candidate) {
  if (candidate.kind === 'local') {
    return {
      mode: 'local',
      local: {
        sub: candidate.repoDir === undefined ? (candidate.command !== undefined && /@penpot\/mcp/.test([candidate.command, ...(candidate.args ?? [])].join(' ')) ? 'npm' : 'repo') : 'repo',
        ...(candidate.repoDir === undefined ? {} : { repoDir: candidate.repoDir }),
        ...(candidate.entry === undefined ? {} : { entry: candidate.entry }),
      },
    }
  }
  const block = candidate.kind === 'official'
    ? { endpoint: candidate.url ?? '', token: candidate.token ?? '', transport: 'http' }
    : { url: candidate.url ?? '', token: candidate.token ?? '', transport: 'http' }
  return {
    mode: candidate.kind,
    [candidate.kind]: block,
  }
}

/**
 * 扫一遍候选，附上「建议动作」与「将会改成什么」。
 *
 * 面板展示用；不改任何文件。
 *
 * @param {object} [options]
 * @returns {{ candidates: Array<import('./detect.js').Candidate & { suggested: string, patch: Record<string, unknown>, blocker?: string }>, errors: string[], scanned: string[] }}
 */
export function planScan(options = {}) {
  const scan = scanAll(options)
  const candidates = scan.candidates.map((candidate) => {
    const patch = patchForCandidate(candidate)
    const blocker = blockerOf(candidate)
    return {
      ...candidate,
      patch,
      suggested: candidate.kind === 'local' ? 'import-and-disable' : 'import-only',
      ...(blocker === undefined ? {} : { blocker }),
    }
  })
  return { candidates, errors: scan.errors, scanned: scan.scanned }
}

/** 某条候选能不能安全迁移；返回阻止原因。 */
function blockerOf(candidate) {
  if (candidate.source === 'dsh' && candidate.wrapper !== undefined) {
    // mcp-lazy 这类外壳：停用它要改 patch 文件，属于 DSH 自己的启动配置，
    // 改错会让 DSH 起不来 —— 允许导入，但停用要用户确认。
    return undefined
  }
  if (candidate.kind === 'official' && (candidate.token === undefined || candidate.token === '')) {
    return '这条是官方托管但没有 userToken：迁过来也用不了（需要 Penpot 里的 MCP key）。'
  }
  return undefined
}

/**
 * 执行迁移。
 *
 * @param {object} options
 * @param {Array<{ candidate: import('./detect.js').Candidate, action: 'import-only' | 'import-and-disable' | 'export-snippet' }>} options.entries
 * @returns {{ ok: true, applied: Array<Record<string, unknown>>, backupDir?: string, configPatch: Record<string, unknown>, warnings: string[] } | { ok: false, error: string }}
 */
export function applyMigration(options) {
  const entries = Array.isArray(options.entries) ? options.entries : []
  const selected = entries.filter((entry) => entry !== null && typeof entry === 'object' && entry.candidate !== undefined)
  if (selected.length === 0) return { ok: false, error: '没有选中任何条目' }

  const warnings = []
  const applied = []
  const configPatch = { mode: undefined, official: undefined, local: undefined, selfhost: undefined }
  const needsDisable = selected.filter((entry) => entry.action === 'import-and-disable')

  let backupDir
  if (needsDisable.length > 0) {
    backupDir = createBackupDir()
  }

  // 先算配置补丁：优先用「来源最亲近」的那条（DSH 自己的配置）
  const sortedForPatch = [...selected].sort((left, right) => {
    const rank = { dsh: 0, project: 1, codex: 2, claude: 2, 'claude-desktop': 3, cursor: 3, gemini: 3 }
    return (rank[left.candidate.source] ?? 9) - (rank[right.candidate.source] ?? 9)
  })
  Object.assign(configPatch, patchForCandidate(sortedForPatch[0].candidate))
  // 把同一实例的其他来源记进 duplicates，供面板展示
  delete configPatch.mode
  const patch = { mode: sortedForPatch[0].candidate.kind === 'local' ? 'local' : sortedForPatch[0].candidate.kind }
  for (const key of ['official', 'local', 'selfhost']) {
    if (configPatch[key] !== undefined) patch[key] = configPatch[key]
  }

  // 再执行停用
  const manifestEntries = []
  for (const entry of needsDisable) {
    const candidate = entry.candidate
    const plan = candidate.disablePlan
    if (plan === undefined) {
      warnings.push(`${candidate.name}：没有可用的停用方案，只导入了配置。`)
      applied.push({ name: candidate.name, source: candidate.source, action: entry.action, disabled: false, reason: 'no-plan' })
      continue
    }
    const backupPath = backupDir === undefined ? undefined : backupFile(backupDir, plan.file)
    try {
      let result
      if (plan.format === 'toml') result = disableTomlServer(plan.file, plan.name)
      else if (plan.format === 'json') result = disableJsonServer(plan.file, plan.name)
      else result = commentYamlEntry(plan.file, plan.entry)
      if (!result.ok) {
        warnings.push(`${candidate.name}：停用失败 —— ${result.error}`)
        applied.push({ name: candidate.name, source: candidate.source, action: entry.action, disabled: false, reason: result.error })
        continue
      }
      manifestEntries.push({
        source: candidate.source,
        name: candidate.name,
        file: plan.file,
        format: plan.format,
        backupPath,
        before: result.before,
        after: result.after,
      })
      applied.push({ name: candidate.name, source: candidate.source, action: entry.action, disabled: true, file: plan.file })
    } catch (error) {
      warnings.push(`${candidate.name}：停用抛错 —— ${String(error?.message ?? error)}`)
      applied.push({ name: candidate.name, source: candidate.source, action: entry.action, disabled: false, reason: String(error?.message ?? error) })
    }
  }

  if (backupDir !== undefined) {
    writeBackupManifest(backupDir, {
      createdAt: new Date().toISOString(),
      entries: manifestEntries,
    })
    // 把 before 原文也落一份，便于还原时不受 manifest 体积影响
    for (const [index, entry] of manifestEntries.entries()) {
      try {
        writeFileSync(join(backupDir, `${String(index).padStart(2, '0')}-before.txt`), entry.before ?? '', 'utf8')
      } catch {
        warnings.push(`备份 ${entry.name} 的原文失败（不影响还原，manifest 里仍有一份）。`)
      }
    }
  }

  // 只导入 / 只导出片段的也记一条
  //
  // `export-snippet` 这个动作之前在界面上可选，但**选了什么也不会发生** ——
  // 这里补上真正的产物：一条可直接粘到别的 MCP 客户端的 JSON / TOML。
  const snippets = []
  for (const entry of selected) {
    if (entry.action === 'import-and-disable') continue
    applied.push({
      name: entry.candidate.name,
      source: entry.candidate.source,
      action: entry.action,
      disabled: false,
    })
    if (entry.action === 'export-snippet') {
      // 用「这条候选自己的」地址而不是当前配置：用户勾这个动作，通常就是想
      // 把那个客户的配置搬出去，而不是导出现在这份
      snippets.push({
        name: entry.candidate.name,
        source: entry.candidate.source,
        ...exportSnippetForCandidate(entry.candidate),
      })
    }
  }

  return {
    ok: true,
    applied,
    ...(backupDir === undefined ? {} : { backupDir }),
    ...(snippets.length === 0 ? {} : { snippets }),
    configPatch: patch,
    warnings,
  }
}

/**
 * 给一条候选生成配置片段（导出动作真正要产出的东西）。
 *
 * @param {import('./detect.js').Candidate} candidate
 * @returns {{ url: string, json: string, toml: string }}
 */
export function exportSnippetForCandidate(candidate) {
  let url = candidate.url ?? ''
  if (candidate.kind === 'local') {
    // 候选里没记端口（它只知道「这是个本地 stdio/http 服务」），用默认值 ——
    // 这也正是 DSH 自己起本地服务时用的那个端口
    url = 'http://127.0.0.1:4401/mcp'
  } else if (typeof candidate.token === 'string' && candidate.token !== '') {
    try {
      const parsed = new URL(url)
      parsed.searchParams.set('userToken', candidate.token)
      url = parsed.toString()
    } catch {
      // 地址不合法就原样给出去，别把 token 拼到一个坏 URL 上
    }
  }
  return {
    url,
    json: JSON.stringify({ mcpServers: { penpot: { type: 'http', url } } }, null, 2),
    toml: `[mcp_servers.penpot]\nurl = "${url}"\n`,
  }
}

/**
 * 还原某条备份。
 *
 * 还原前再备份一次当前内容（"还原"本身也可能是误操作）。
 *
 * @param {string} dir 备份目录
 * @returns {{ ok: true, restored: string[], undoDir?: string } | { ok: false, error: string }}
 */
export function restoreBackup(dir) {
  if (typeof dir !== 'string' || dir === '') return { ok: false, error: '没有指定备份' }
  const manifest = readBackupManifest(dir)
  if (manifest === undefined || !Array.isArray(manifest.entries)) {
    return { ok: false, error: '备份缺少 manifest.json，无法安全还原' }
  }
  const undoDir = createBackupDir()
  const undoEntries = []
  const restored = []
  for (const entry of manifest.entries) {
    if (typeof entry.file !== 'string' || typeof entry.before !== 'string') continue
    try {
      // 还原前把「现在的样子」也存一份
      const current = readFileText(entry.file)
      if (current !== undefined) {
        undoEntries.push({ source: entry.source, name: entry.name, file: entry.file, format: entry.format, before: current, after: entry.before })
        backupFile(undoDir, entry.file)
      }
      writeFileSync(entry.file, entry.before, 'utf8')
      restored.push(entry.file)
    } catch (error) {
      return { ok: false, error: `还原 ${entry.file} 失败：${String(error?.message ?? error)}` }
    }
  }
  if (undoEntries.length > 0) {
    writeBackupManifest(undoDir, { createdAt: new Date().toISOString(), entries: undoEntries, restoredFrom: dir })
  }
  return { ok: true, restored, undoDir }
}

function readFileText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/** 备份清单（面板展示）。 */
export function backups() {
  return listBackups()
}