/**
 * 扫描本机所有 MCP 客户端配置，找出里面的 penpot 条目。
 *
 * 这份扫描器被两处消费，因此必须是**同一个实现**：
 *   1. 自动判定（mode: auto）—— 首次加载时看这台机器上已经有什么 penpot 配置；
 *   2. 迁移（面板「扫描」）—— 把别的客户端的 penpot 条目搬过来 / 就地停用。
 * 两者各写一份必然漂移（识别规则、去重口径、URL 归一都会不一致）。
 *
 * 识别规则（按实测特征，不按「Auth=OAuth」筛 —— 那会把 hyperframes 误伤）：
 *   - 名字含 penpot
 *   - 或 command/args/url 含 penpot / @penpot/mcp / penpot-stdio-bridge / 4401 / 4402 / mcp/stream
 *
 * @module dsh-plugin-penpot/detect
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import net from 'node:net'
import {
  disableJsonServer,
  disableTomlServer,
  commentYamlEntry,
  readJsonMcpServers,
  readTomlMcpServers,
  readYamlPatchEntries,
  findJsonLine,
} from './formats.js'
import { extractToken, dshHome } from './store.js'

/** 判定的连接档（与 config.MODES 的取值对齐，去掉 auto）。 */
export const KINDS = ['official', 'local', 'selfhost']

/** Penpot 的关键词。 */
const PENPOT_HINTS = [/penpot/i, /@penpot\/mcp/i, /penpot-stdio-bridge/i]

/**
 * 一条被识别到的 penpot 配置。
 *
 * @typedef {{
 *   source: string,
 *   sourceLabel: string,
 *   path: string,
 *   line?: number,
 *   name: string,
 *   kind: 'official' | 'local' | 'selfhost',
 *   url?: string,
 *   token?: string,
 *   command?: string,
 *   args: string[],
 *   repoDir?: string,
 *   entry?: string,
 *   cwd?: string,
 *   enabled: boolean,
 *   raw: unknown,
 *   disablePlan?: { format: 'toml' | 'json' | 'yaml', file: string, name: string, entry?: unknown },
 *   note?: string,
 * }} Candidate
 */

/**
 * 文本里是否像 penpot。
 * @param {string[]} pieces
 */
export function looksLikePenpotText(pieces) {
  const joined = pieces.filter((piece) => typeof piece === 'string').join(' ')
  if (joined === '') return false
  if (PENPOT_HINTS.some((re) => re.test(joined))) return true
  // 纯端口特征：4401/4402 只有在同时出现 mcp/http/localhost 时才算
  return /(?::440[12]\b)/.test(joined) && /(mcp|http|localhost|127\.0\.0\.1)/i.test(joined)
}

/**
 * 把一个 URL 归到某一档。
 *
 * @param {string} url
 * @returns {'official' | 'selfhost' | 'local'}
 */
export function classifyUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'selfhost'
  }
  const host = parsed.hostname.toLowerCase()
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return 'local'
  if (host === 'design.penpot.app' || host === 'test-mcp.penpot.dev' || host.endsWith('.penpot.app')) return 'official'
  return 'selfhost'
}

/**
 * 从 stdio 的 command/args 里推断本地仓库信息。
 *
 * 两种真实形态：
 *   - 直接跑 dist：node <repo>/packages/server/dist/index.js
 *   - 跑桥：node <repo>/packages/server/penpot-stdio-bridge.mjs
 * 两者都能从路径里剥出 repoDir（到 `packages/server` 的上一级）。
 *
 * @param {string} command
 * @param {string[]} args
 */
export function classifyStdio(command, args) {
  const all = [command, ...(args ?? [])].filter((piece) => typeof piece === 'string')
  const joined = all.join(' ')
  if (/@penpot\/mcp/.test(joined)) {
    return { kind: 'local', sub: 'npm', note: 'npx @penpot/mcp（官方发布包，本地跑）' }
  }
  const scriptPath = all.find((piece) => /(dist[\\/]index\.js|penpot-stdio-bridge\.mjs)$/i.test(piece))
  if (scriptPath !== undefined) {
    const normalized = scriptPath.replace(/\\/g, '/')
    const marker = '/packages/server/'
    const index = normalized.indexOf(marker)
    // 桥文件要归一成真正的服务器入口：这个插件自己就是 MCP 客户端，
    // 不需要再套一层 stdio→HTTP 的桥（那会多一个进程，还抢着起同一个服务）。
    const isBridge = /penpot-stdio-bridge\.mjs$/i.test(normalized)
    if (index >= 0) {
      const repoDir = normalized.slice(0, index)
      const entry = isBridge ? 'packages/server/dist/index.js' : normalized.slice(index + 1)
      return {
        kind: 'local',
        sub: 'repo',
        repoDir: repoDir.replace(/\//g, process.platform === 'win32' ? '\\' : '/'),
        entry,
        note: isBridge
          ? '本地仓库构建产物（原配置走 stdio 桥，已归一成直连 HTTP 服务）'
          : '本地仓库构建产物',
      }
    }
    return {
      kind: 'local',
      sub: 'repo',
      repoDir: undefined,
      entry: isBridge ? undefined : scriptPath,
      note: '本地脚本（路径无法推断仓库根）',
    }
  }
  if (/penpot/i.test(joined)) {
    return { kind: 'local', sub: 'repo', note: '疑似本地 penpot 脚本' }
  }
  return undefined
}

/** 扫描结果里的一个「来源」（可能有权限错误）。 */
function safeStat(path) {
  try { return statSync(path) } catch { return undefined }
}

function safeReadDir(path) {
  try { return readdirSync(path) } catch { return [] }
}

/**
 * 收集本次扫描要看的文件清单。
 *
 * @param {object} [options]
 * @param {string} [options.cwd] 项目根（默认 process.cwd()）
 * @param {string} [options.home] 用户家目录（测试注入用）
 * @param {string} [options.dshHome] DSH 家目录（测试注入用）
 * @returns {{ files: { path: string, format: 'toml' | 'json' | 'yaml', source: string }[], skipped: { path: string, reason: string }[] }}
 */
export function collectConfigFiles(options = {}) {
  const home = options.home ?? homedir()
  const cwd = options.cwd ?? process.cwd()
  const dsh = options.dshHome ?? dshHome()
  const files = []
  const skipped = []

  const push = (path, format, source) => {
    if (typeof path !== 'string' || path === '') return
    if (!existsSync(path)) return
    const stat = safeStat(path)
    if (stat === undefined || !stat.isFile()) return
    if (files.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) return
    files.push({ path, format, source })
  }

  // DSH：所有 profile 的补丁层
  for (const profileName of safeReadDir(join(dsh, 'profiles'))) {
    push(join(dsh, 'profiles', profileName, 'cordis.patch.yml'), 'yaml', 'dsh')
    push(join(dsh, 'profiles', profileName, 'cordis.yml'), 'yaml', 'dsh')
  }

  // Codex
  push(join(home, '.codex', 'config.toml'), 'toml', 'codex')

  // Claude Code
  push(join(home, '.claude.json'), 'json', 'claude')
  push(join(home, '.claude', 'settings.json'), 'json', 'claude')
  push(join(home, '.claude', 'mcp.json'), 'json', 'claude')

  // Claude Desktop
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    if (typeof appData === 'string' && appData !== '') {
      push(join(appData, 'Claude', 'claude_desktop_config.json'), 'json', 'claude-desktop')
      push(join(appData, 'Cursor', 'User', 'settings.json'), 'json', 'cursor')
    }
  } else if (process.platform === 'darwin') {
    push(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'json', 'claude-desktop')
    push(join(home, 'Library', 'Application Support', 'Cursor', 'User', 'settings.json'), 'json', 'cursor')
  }

  // Cursor / Gemini
  push(join(home, '.cursor', 'mcp.json'), 'json', 'cursor')
  push(join(home, '.gemini', 'settings.json'), 'json', 'gemini')

  // 项目级
  push(join(cwd, '.mcp.json'), 'json', 'project')
  push(join(cwd, '.vscode', 'mcp.json'), 'json', 'project')
  push(join(cwd, '.agents', 'mcp.json'), 'json', 'project')
  push(join(cwd, '.mimocode', 'mcp.json'), 'json', 'project')

  return { files, skipped }
}

/**
 * 把一条 server 定义归一成候选。
 *
 * @param {object} input
 * @param {string} input.source
 * @param {string} input.path
 * @param {string} input.name
 * @param {Record<string, unknown>} input.value
 * @param {number} [input.line]
 * @param {boolean} [input.enabled]
 * @param {{ format: 'toml' | 'json' | 'yaml', file: string, name: string, entry?: unknown }} [input.disablePlan]
 * @returns {Candidate | undefined}
 */
export function toCandidate(input) {
  const value = input.value ?? {}
  const url = typeof value.url === 'string' ? value.url : (typeof value.endpoint === 'string' ? value.endpoint : undefined)
  const command = typeof value.command === 'string' ? value.command : undefined
  const args = Array.isArray(value.args) ? value.args.map((piece) => String(piece)) : []

  const nameHits = /penpot/i.test(input.name)
  const urlHits = typeof url === 'string' && looksLikePenpotText([url])
  const cmdHits = looksLikePenpotText([command ?? '', ...args])
  if (!nameHits && !urlHits && !cmdHits) return undefined

  const base = {
    source: input.source,
    sourceLabel: SOURCE_LABEL(input.source),
    path: input.path,
    line: input.line,
    name: input.name,
    args,
    enabled: input.enabled !== false,
    raw: value,
    disablePlan: input.disablePlan,
  }

  if (typeof url === 'string' && url !== '') {
    const { url: cleanUrl, token } = extractToken(url)
    return {
      ...base,
      kind: classifyUrl(cleanUrl),
      url: cleanUrl,
      token,
      note: token === '' ? 'URL 里没有 userToken' : undefined,
    }
  }

  if (command !== undefined) {
    const stdio = classifyStdio(command, args)
    if (stdio === undefined) {
      return { ...base, kind: 'local', command, note: '无法从命令行识别形态' }
    }
    return {
      ...base,
      kind: stdio.kind,
      command,
      repoDir: stdio.repoDir,
      entry: stdio.entry,
      note: stdio.note,
    }
  }

  return { ...base, kind: 'local', note: '既没有 url 也没有 command' }
}

function SOURCE_LABEL(source) {
  switch (source) {
    case 'dsh': return 'DSH 插件配置'
    case 'codex': return 'Codex'
    case 'claude': return 'Claude Code'
    case 'claude-desktop': return 'Claude Desktop'
    case 'cursor': return 'Cursor'
    case 'gemini': return 'Gemini CLI'
    case 'project': return '项目级配置'
    default: return '未知来源'
  }
}

/**
 * 读一个配置文件，抽出里面所有 penpot 候选。
 *
 * @param {{ path: string, format: 'toml' | 'json' | 'yaml', source: string }} file
 * @returns {{ candidates: Candidate[], errors: string[] }}
 */
export function scanFile(file) {
  const errors = []
  const candidates = []

  if (file.format === 'toml') {
    const read = readTomlMcpServers(file.path)
    if (!read.ok) return { candidates, errors: [`${file.path}: ${read.error}`] }
    for (const server of read.servers) {
      const candidate = toCandidate({
        source: file.source,
        path: file.path,
        name: server.name,
        value: { url: server.url, command: server.command, args: server.args },
        line: server.headerLine,
        enabled: server.enabled !== false,
        disablePlan: { format: 'toml', file: file.path, name: server.name },
      })
      if (candidate !== undefined) candidates.push(candidate)
    }
    return { candidates, errors }
  }

  if (file.format === 'json') {
    const read = readJsonMcpServers(file.path)
    if (!read.ok) return { candidates, errors: [`${file.path}: ${read.error}`] }
    for (const server of read.servers) {
      const candidate = toCandidate({
        source: file.source,
        path: file.path,
        name: server.name,
        value: server.value,
        line: server.line,
        enabled: server.value.disabled !== true,
        disablePlan: { format: 'json', file: file.path, name: server.name },
      })
      if (candidate !== undefined) candidates.push(candidate)
    }
    return { candidates, errors }
  }

  // YAML：cordis.patch.yml 的 insert 列表
  const read = readYamlPatchEntries(file.path)
  if (!read.ok) return { candidates, errors: [`${file.path}: ${read.error}`] }
  for (const entry of read.entries) {
    // 表示「已停用」：id 行或首行被注释掉时 readYamlPatchEntries 压根读不到它，
    // 所以能读到就是启用中；这里额外尊重显式的 disabled: true
    const fields = entry.fields ?? {}
    const value = {
      url: fields.url,
      command: fields.command,
      args: entry.args,
      serverName: fields.serverName,
      transport: fields.transport,
    }
    // mcp-lazy 这类「外壳插件」：真正的身份在 config.serverName / config.command /
    // config.url 里，所以把 serverName 也拼进识别文本。
    const probeValue = {
      ...value,
      serverName: fields.serverName,
    }
    const candidate = toCandidate({
      source: file.source,
      path: file.path,
      name: String(fields.serverName || entry.id || entry.name),
      value: probeValue,
      line: entry.startLine,
      enabled: String(fields.disabled ?? '').trim() !== 'true',
      disablePlan: { format: 'yaml', file: file.path, name: entry.id, entry },
    })
    if (candidate === undefined) continue
    // 补上外壳信息：这条实际是 mcp-lazy 之类插件的一个实例
    candidate.wrapper = { id: entry.id, name: entry.name }
    candidates.push(candidate)
  }
  return { candidates, errors }
}

/**
 * 跑一次完整扫描。
 *
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {string} [options.cwd]
 * @param {string} [options.dshHome]
 * @returns {{ candidates: Candidate[], errors: string[], scanned: string[] }}
 */
export function scanAll(options = {}) {
  const { files } = collectConfigFiles(options)
  const candidates = []
  const errors = []
  const scanned = []
  for (const file of files) {
    scanned.push(file.path)
    const result = scanFile(file)
    candidates.push(...result.candidates)
    errors.push(...result.errors)
  }
  return { candidates: dedupe(candidates), errors, scanned }
}

/**
 * 去重：指向同一个本地实例 / 同一个远端端点的条目视为同一个目标。
 *
 * 典型场景：DSH 的 mcp-lazy-penpot 与 Codex 的 [mcp_servers.penpot] 都指向
 * localhost:4401，迁移时只该搬一次。
 *
 * 保留「更亲近」的那条作为主条目（DSH 自己的配置优先），其余进 duplicates。
 *
 * @param {Candidate[]} candidates
 */
export function dedupe(candidates) {
  /** @type {Map<string, Candidate & { duplicates: Array<Record<string, unknown>> }>} */
  const groups = new Map()
  for (const candidate of candidates) {
    const key = identityKey(candidate)
    if (key === undefined) {
      // 没有身份键的（比如既无 url 又无 command）各自独立，不合并
      groups.set(`anon:${groups.size}:${candidate.path}:${candidate.name}`, { ...candidate, duplicates: [] })
      continue
    }
    const summary = {
      source: candidate.source,
      path: candidate.path,
      name: candidate.name,
      line: candidate.line,
    }
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { ...candidate, duplicates: [] })
      continue
    }
    // 把两条里较不亲近的那条记进 duplicates，较亲近的当主条目
    const existingRank = sourceRank(existing.source)
    const candidateRank = sourceRank(candidate.source)
    if (candidateRank < existingRank) {
      groups.set(key, {
        ...candidate,
        duplicates: [
          { source: existing.source, path: existing.path, name: existing.name, line: existing.line },
          ...existing.duplicates,
        ],
      })
    } else {
      existing.duplicates.push(summary)
    }
  }
  return [...groups.values()]
}

/** 来源的亲疏：数字越小越亲近（DSH 自己配的优先）。 */
export function sourceRank(source) {
  switch (source) {
    case 'dsh': return 0
    case 'project': return 1
    case 'codex': return 2
    case 'claude': return 2
    case 'claude-desktop': return 3
    case 'cursor': return 3
    case 'gemini': return 3
    default: return 9
  }
}

/** 去重用的身份键：本地按端口，远端按 URL。 */
export function identityKey(candidate) {
  if (candidate.kind === 'local') {
    const port = localPortOf(candidate)
    return port === undefined ? undefined : `local:${port}`
  }
  if (typeof candidate.url === 'string' && candidate.url !== '') {
    try {
      const parsed = new URL(candidate.url)
      return `remote:${parsed.origin}${parsed.pathname}`
    } catch {
      return `remote:${candidate.url}`
    }
  }
  return undefined
}

/** 本地候选的 HTTP 端口（从 url / args / 默认值推）。 */
export function localPortOf(candidate) {
  const needles = [candidate.url ?? '', candidate.command ?? '', ...(candidate.args ?? [])]
  for (const needle of needles) {
    // 支持 --port=4599 / PORT=4599 / :4599
    const match = /(?:^|[:\s=])(\d{4,5})\b/.exec(String(needle))
    if (match !== null) {
      const port = Number.parseInt(match[1], 10)
      if (port >= 1024 && port <= 65_535) return port
    }
  }
  return candidate.kind === 'local' ? 4401 : undefined
}

// ── 探测可达性 ───────────────────────────────────────────────────────────────

/**
 * 探测一条候选现在能不能用。
 *
 * 不抛错：连不上就是连不上，判定流程要继续往下走。
 *
 * @param {Candidate} candidate
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ reachable: boolean, reason: string }>}
 */
export async function probeCandidate(candidate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500
  if (candidate.kind === 'local') {
    const port = localPortOf(candidate)
    if (port === undefined) return { reachable: false, reason: '无法确定端口' }
    const host = candidate.url === undefined ? '127.0.0.1' : (new URL(candidate.url).hostname || '127.0.0.1')
    const open = await tcpProbe(host, port, timeoutMs)
    if (!open) return { reachable: false, reason: `${host}:${port} 没有服务在监听` }
    // 端口开着 ≠ 是 penpot：4401 上完全可能是别的东西（实测有人在那儿放了自己的服务）。
    // 再发一次 initialize 确认对面真的说 MCP —— 比「端口在听」可靠得多。
    const speaksMcp = await mcpInitialize(`http://${host}:${port}/mcp`, timeoutMs)
    return speaksMcp.ok
      ? { reachable: true, reason: `${host}:${port} 是 MCP 服务（${speaksMcp.detail}）` }
      : { reachable: false, reason: `${host}:${port} 有服务在监听，但不像 penpot MCP（${speaksMcp.detail}）` }
  }
  if (typeof candidate.url !== 'string' || candidate.url === '') {
    return { reachable: false, reason: '没有 URL' }
  }
  const target = joinToken(candidate.url, candidate.token)
  const result = await mcpInitialize(target, timeoutMs)
  return result.ok
    ? { reachable: true, reason: `HTTP ${result.status}` }
    : { reachable: false, reason: result.detail }
}

/**
 * 发一次 MCP `initialize`，看对面是不是真的 MCP 服务。
 *
 * 为什么值得多发这一轮：Penpot 的 `initialize` **不需要任何凭据**也返回 200，
 * 所以它对「key 对不对」毫无判断力 —— 但对「这是不是一个 MCP 端点」判断得很准。
 * 自动判定要的正是后者。
 *
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, status?: number, detail: string }>}
 */
async function mcpInitialize(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-penpot/probe', version: '0.2.0' },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, status: response.status, detail: `HTTP ${response.status}` }
    // MCP 的响应可能是 JSON，也可能是 SSE 流；这里只看有没有 JSON-RPC 的痕迹
    const text = await response.text()
    if (/"jsonrpc"|"serverInfo"|event:\s*message/.test(text)) {
      return { ok: true, status: response.status, detail: `HTTP ${response.status}` }
    }
    return { ok: false, status: response.status, detail: '返回的不是 MCP 响应' }
  } catch (error) {
    const message = String(error?.message ?? error)
    return { ok: false, detail: message === 'This operation was aborted' ? '超时' : message.slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

function joinToken(url, token) {
  if (typeof token !== 'string' || token === '') return url
  try {
    const parsed = new URL(url)
    parsed.searchParams.set('userToken', token)
    return parsed.toString()
  } catch {
    return url
  }
}

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

// ── 自动判定 ─────────────────────────────────────────────────────────────────

/**
 * 默认兜底：本机有没有可用的本地构建？
 *
 * @param {string} repoDir
 * @param {string} entry
 */
function localBuildExists(repoDir, entry) {
  if (typeof repoDir !== 'string' || repoDir === '') return false
  try {
    return existsSync(join(repoDir, entry || 'packages/server/dist/index.js'))
  } catch {
    return false
  }
}

/**
 * 首启自动判定：看这台机器上已经有什么 penpot 配置，用那一条当默认。
 *
 * 优先级（与计划 §2.D 一致）：
 *   ① 可达 且 来自 DSH 自己的 profile        ← 最亲近：这台机器为 DSH 配的
 *   ② 可达 且 来自其他 agent
 *   ③ 可达 且 只有 URL（没有配置来源）
 *   ④ 全部不可达 → 仍按 ①→②→③ 挑「配置最完整」的那条，标 offline
 *   ⑤ 一条都没扫到 → 有本地构建就 local，否则 official
 *
 * 关键设计：扫到但连不上时**不替用户猜成别的一档**。真实结论永远显示在面板上，
 * 用户一眼能看到该起来哪个进程。
 *
 * @param {object} [options]
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} [options.config]
 * @param {string} [options.home]
 * @param {string} [options.cwd]
 * @param {string} [options.dshHome]
 * @param {number} [options.probeTimeoutMs]
 * @returns {Promise<{
 *   picked: 'official' | 'local' | 'selfhost',
 *   from: string,
 *   rationale: string,
 *   offline: boolean,
 *   candidates: Array<Candidate & { reachable: boolean, reason: string, rank: number }>,
 *   scanned: string[],
 *   errors: string[],
 * }>}
 */
export async function decideAuto(options = {}) {
  const config = options.config
  const scan = scanAll({
    home: options.home,
    cwd: options.cwd,
    dshHome: options.dshHome,
  })

  const timed = await Promise.all(
    scan.candidates.map(async (candidate) => {
      const probe = await probeCandidate(candidate, { timeoutMs: options.probeTimeoutMs ?? 1500 })
      return { ...candidate, reachable: probe.reachable, reason: probe.reason, rank: sourceRank(candidate.source) }
    }),
  )

  const describe = (entry) => {
    const where = entry.line === undefined ? entry.path : `${entry.path}:${entry.line}`
    const tag = `${SOURCE_LABEL(entry.source)} ${entry.name}`
    return `${tag} @ ${where}`
  }

  const reachable = timed.filter((entry) => entry.reachable)
  const pool = reachable.length > 0 ? reachable : timed
  const offline = reachable.length === 0 && timed.length > 0

  if (pool.length === 0) {
    // 一条都没扫到 → 兜底
    const repoDir = config?.local?.repoDir ?? ''
    const entry = config?.local?.entry ?? 'packages/server/dist/index.js'
    if (localBuildExists(repoDir, entry)) {
      return {
        picked: 'local',
        from: 'fallback',
        rationale: `没扫到任何 penpot 配置；本机有可用的本地构建（${join(repoDir, entry)}），先用它。`,
        offline: false,
        candidates: timed,
        scanned: scan.scanned,
        errors: scan.errors,
      }
    }
    return {
      picked: 'official',
      from: 'fallback',
      rationale: '没扫到任何 penpot 配置，本机也没有本地构建；默认连官方托管（需要你去 Penpot Integrations 生成 MCP key）。',
      offline: false,
      candidates: timed,
      scanned: scan.scanned,
      errors: scan.errors,
    }
  }

  // 排序：可达优先 → 来源亲疏 → 配置完整度（有 token / 有具体路径更好）
  const completeness = (entry) => {
    let score = 0
    if (typeof entry.token === 'string' && entry.token !== '') score += 2
    if (entry.kind === 'local' && typeof entry.repoDir === 'string' && entry.repoDir !== '') score += 2
    if (typeof entry.url === 'string' && entry.url !== '') score += 1
    if (entry.duplicates !== undefined && entry.duplicates.length > 0) score += 1
    return score
  }

  const sorted = [...pool].sort((left, right) => {
    if (left.reachable !== right.reachable) return left.reachable ? -1 : 1
    if (left.rank !== right.rank) return left.rank - right.rank
    return completeness(right) - completeness(left)
  })

  const winner = sorted[0]
  const lines = []
  if (offline) {
    lines.push(`识别到 ${timed.length} 条 penpot 配置，但**都连不上**（这是如实结论，不猜成别的档）。`)
    lines.push(`按来源亲疏挑了最完整的一条：${describe(winner)}`)
    lines.push(`它现在不可用的原因：${winner.reason}`)
    if (winner.kind === 'local') lines.push('面板上的动作是「启动本地实例」，不是改成官方。')
  } else {
    lines.push(`识别到 ${timed.length} 条 penpot 配置，其中 ${reachable.length} 条可达。`)
    lines.push(`采用 ${describe(winner)}（${winner.reason}）。`)
  }
  if (winner.duplicates !== undefined && winner.duplicates.length > 0) {
    lines.push(`另有 ${winner.duplicates.length} 条指向同一个目标：${winner.duplicates.map((entry) => `${SOURCE_LABEL(entry.source)} ${entry.name}`).join('、')}。`)
  }

  return {
    picked: winner.kind,
    from: describe(winner),
    rationale: lines.join('\n'),
    offline,
    candidates: timed,
    scanned: scan.scanned,
    errors: scan.errors,
  }
}
