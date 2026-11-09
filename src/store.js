/**
 * 状态持久化：设置页改的值、自动判定结果、本地进程的 run.json、迁移备份。
 *
 * 为什么不直接改 `cordis.patch.yml`：那是用户手写的部署文件，插件不该覆写它 ——
 * 用户下次编辑会和插件写入打架，而且 YAML 注释会被吃掉。
 *
 * 所以分两层：
 *   - `cordis.patch.yml` 里的 `config` 是**部署默认值**（用户或发行方定的）
 *   - 设置页改的写进 `<dsh home>/data/dsh-plugin-penpot/config.json`，覆盖同名项
 *
 * 目录布局（都在同一个 data 目录下，便于用户一键备份/清空）：
 *   data/dsh-plugin-penpot/
 *     ├─ config.json          用户覆盖项
 *     ├─ detected.json        自动判定的结果（单独存，避免和用户手动改的混在一起）
 *     ├─ local-run.json       本地进程的 pid/端口/启动时间，用于孤儿回收
 *     └─ backups/<时间戳>/    迁移前的原文件 + manifest.json
 *
 * @module dsh-plugin-penpot/store
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, copyFileSync, statSync, renameSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { homedir } from 'node:os'
import { splitUserToken } from './config.js'

/** DSH 家目录：`DSH_HOME` 优先，否则 `~/.dsh`。 */
export function dshHome() {
  const explicit = process.env.DSH_HOME
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit
  return join(homedir(), '.dsh')
}

/** 本插件的数据目录。 */
export function dataDir() {
  return join(dshHome(), 'data', 'dsh-plugin-penpot')
}

/** 某个文件名在数据目录下的绝对路径。 */
export function dataFile(name) {
  return join(dataDir(), name)
}

/** 备份根目录。 */
export function backupsDir() {
  return join(dataDir(), 'backups')
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    return fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  // 原子替换：写一半崩溃不会留下半个 JSON 让下次启动读不出来。
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    try { rmSync(tmp, { force: true }) } catch {}
  }
  return value
}

// ── 用户覆盖配置 ─────────────────────────────────────────────────────────────

/** 读一次就记住，避免每次调用都碰磁盘。 */
let configCache

/** 读用户覆盖项（空对象 = 没有覆盖）。 */
export function readOverrides() {
  if (configCache !== undefined) return configCache
  configCache = readJson(dataFile('config.json'), {})
  return configCache
}

/**
 * 写用户覆盖项（深合并一个 patch）。
 *
 * `undefined` 值表示「删掉这个覆盖项，回落默认」。
 *
 * @param {Record<string, unknown>} patch
 * @returns {{ ok: true, overrides: Record<string, unknown> } | { ok: false, error: string }}
 */
export function writeOverrides(patch) {
  const next = mergeDeep({}, readOverrides())
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value === undefined) delete next[key]
    else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      next[key] = mergeDeep(next[key] ?? {}, value)
    } else next[key] = value
  }
  try {
    writeJson(dataFile('config.json'), next)
    configCache = next
    return { ok: true, overrides: next }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/** 深合并：右侧覆盖左侧，对象递归，数组整体替换。 */
export function mergeDeep(left, right) {
  const out = { ...(left ?? {}) }
  for (const [key, value] of Object.entries(right ?? {})) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeDeep(out[key], value)
    } else out[key] = value
  }
  return out
}

/** 清掉缓存，下次读盘。测试用。 */
export function resetCache() {
  configCache = undefined
  detectedCache = undefined
}

// ── 自动判定结果 ─────────────────────────────────────────────────────────────

let detectedCache

/** 读上次自动判定的结果。 */
export function readDetected() {
  if (detectedCache !== undefined) return detectedCache
  detectedCache = readJson(dataFile('detected.json'), {})
  return detectedCache
}

/**
 * 存自动判定结果。
 * @param {{ picked?: string, from?: string, rationale?: string, candidates?: unknown[] }} value
 */
export function writeDetected(value) {
  const next = {
    picked: typeof value?.picked === 'string' ? value.picked : '',
    from: typeof value?.from === 'string' ? value.from : '',
    rationale: typeof value?.rationale === 'string' ? value.rationale : '',
    pickedAt: new Date().toISOString(),
    candidates: Array.isArray(value?.candidates) ? value.candidates : [],
  }
  try {
    writeJson(dataFile('detected.json'), next)
  } catch {
    // 写不进去不影响运行：判定结果只用于展示与下一次的 in-memory 提示
  }
  detectedCache = next
  return next
}

// ── 本地进程运行记录（孤儿回收） ─────────────────────────────────────────────

/**
 * 记录我们拉起的本地进程。
 * @param {{ pid: number, ports: { http: number, ws: number, repl: number }, startedAt: string, command: string, cwd: string } | undefined} value
 */
export function writeRunRecord(value) {
  try {
    if (value === undefined) {
      rmSync(dataFile('local-run.json'), { force: true })
      return
    }
    writeJson(dataFile('local-run.json'), value)
  } catch {
    // 运行记录写不进去只影响「下次启动能否接管」，不该阻断当前启动
  }
}

/** 读上次的本地进程记录。 */
export function readRunRecord() {
  return readJson(dataFile('local-run.json'), undefined)
}

// ── 迁移备份 ─────────────────────────────────────────────────────────────────

/** 新备份目录：`backups/<yyyyMMdd-HHmmss>-<rand>/`。 */
export function createBackupDir() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const dir = join(backupsDir(), `${stamp}-${Math.random().toString(36).slice(2, 8)}`)
  ensureDir(dir)
  return dir
}

/**
 * 把一个文件原样拷进备份目录，返回备份路径。
 *
 * 保留相对层级（用扁平化的 `__` 连接），避免路径穿越也避免重名覆盖。
 *
 * @param {string} dir 备份目录
 * @param {string} file 原文件
 */
export function backupFile(dir, file) {
  const flat = file.replace(/^[A-Za-z]:/, '').replace(/[\\/]+/g, '__').replace(/^__/, '')
  const target = join(dir, flat)
  try {
    copyFileSync(file, target)
    return target
  } catch {
    return undefined
  }
}

/**
 * 列出所有备份目录（新的在前），带每条备份的 manifest 摘要。
 */
export function listBackups() {
  const root = backupsDir()
  if (!existsSync(root)) return []
  let names
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out = []
  for (const name of names.sort().reverse()) {
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const manifest = readJson(join(dir, 'manifest.json'), undefined)
    out.push({
      name,
      dir,
      createdAt: manifest?.createdAt ?? '',
      entries: Array.isArray(manifest?.entries) ? manifest.entries.length : 0,
      summary: Array.isArray(manifest?.entries)
        ? manifest.entries.map((entry) => `${entry.source}:${entry.name}`)
        : [],
    })
  }
  return out
}

/** 读某条备份的 manifest。 */
export function readBackupManifest(dir) {
  return readJson(join(dir, 'manifest.json'), undefined)
}

/** 写某条备份的 manifest。 */
export function writeBackupManifest(dir, manifest) {
  try {
    writeJson(join(dir, 'manifest.json'), manifest)
  } catch {
    // 备份记录写失败时上层仍可手工还原，不抛
  }
}

/** 删掉某条备份。 */
export function removeBackup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

// ── 密钥脱敏 ─────────────────────────────────────────────────────────────────

/**
 * token 的对外形态：永远不回显真值，只说有没有配。
 *
 * 设置页是浏览器环境，把 token 原样送到前端意味着它会出现在 DOM、devtools、
 * 以及任何一次网络抓包里。既然用户只需要「改」和「清」，回显没有收益。
 *
 * @param {string | undefined} token
 */
export function maskToken(token) {
  if (typeof token !== 'string' || token === '') return { configured: false }
  const tail = token.length <= 8 ? token.slice(-2) : token.slice(-4)
  return { configured: true, preview: `…${tail}`, length: token.length }
}

/**
 * 从 URL 里剥掉 userToken（保留其他参数），用于回显与日志。
 *
 * @param {string} url
 */
export function redactUrl(url) {
  if (typeof url !== 'string' || url === '') return url
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.has('userToken')) parsed.searchParams.set('userToken', '***')
    return parsed.toString()
  } catch {
    return url.replace(/([?&]userToken=)[^&]*/i, '$1***')
  }
}

// ── 脱敏占位符护栏 ───────────────────────────────────────────────────────────

/**
 * `redactUrl()` 把 token 换成这个占位符再回显给面板。
 *
 * 它**绝对不能**被写回磁盘：面板把回显值填进输入框，用户点一下「保存」
 * 就会把 `userToken=***` 原样存下来，等于当场覆盖掉真凭据（实测发生过，
 * 见 CHANGELOG）。所以写盘前有一道护栏，见 `guardPatch()`。
 */
export const REDACTED_PLACEHOLDER = '***'

/** 这个值里是否带着脱敏占位符（即它不可能是一份好配置）。 */
export function hasPlaceholderToken(value) {
  if (typeof value === 'string') {
    if (!value.includes(REDACTED_PLACEHOLDER)) return false
    // 只在「像 token 位置」上判定，避免误伤正常文案里的三个星号
    return /([?&]userToken=)\*\*\*|^(\*\*\*)$/i.test(value)
  }
  if (Array.isArray(value)) return value.some(hasPlaceholderToken)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some(hasPlaceholderToken)
  }
  return false
}

/**
 * 把 patch 里的「URL 里的 userToken」拆到独立字段，让**存储形态只有一个**。
 *
 * 支持三种历史形态会让读取逻辑到处判断，所以写盘前就归一：
 * 不管用户是把完整地址粘在端点框、还是粘贴框，落盘永远是
 * `endpoint` 干净 + `token` 单独存。
 *
 * @param {Record<string, unknown>} patch
 * @returns {Record<string, unknown>}
 */
export function normalizeCredentials(patch) {
  const out = { ...(patch ?? {}) }
  const pairs = [
    ['official', 'endpoint', 'token'],
    ['selfhost', 'url', 'token'],
  ]
  for (const [block, urlKey, tokenKey] of pairs) {
    const incoming = patch?.[block]
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) continue
    const rawUrl = typeof incoming[urlKey] === 'string' ? incoming[urlKey] : ''
    if (rawUrl === '') continue
    const explicit = typeof incoming[tokenKey] === 'string' ? incoming[tokenKey] : ''
    const split = splitUserToken(rawUrl, explicit)
    if (split.token === '') continue
    out[block] = { ...incoming, [urlKey]: split.url, [tokenKey]: split.token }
  }
  return out
}

/**
 * 补回「这一轮没提交、但原来有的」凭据。
 *
 * ## 为什么需要它
 *
 * 面板的端点输入框只显示地址（token 必须脱敏），所以用户保存一次，
 * 提交上来的就是一份**没有 token 的地址**。如果直接写盘，凭据就没了 ——
 * 这个事故真的发生过两次。
 *
 * 第一版护栏（`guardPatch`）只拦 `userToken=***` 那种占位符，拦不住
 * 「被摘干净之后提交上来的干净地址」，因为那时字符串里连 `***` 都没有。
 *
 * 所以护栏改成两层：
 *   1. `guardPatch`  —— 拦占位符（防脏数据写盘）
 *   2. 这个函数      —— 防**丢失**：patch 里没带 token，就沿用磁盘上已有的
 *
 * 它只在「确实有旧值」时补，所以用户主动清空（传空串）仍然有效。
 *
 * @param {Record<string, unknown>} patch 待写入的覆盖项
 * @param {Record<string, unknown>} current 磁盘上已有的覆盖项
 * @returns {{ patch: Record<string, unknown>, kept: string[] }}
 */
export function keepCredentials(patch, current) {
  const kept = []
  const out = { ...(patch ?? {}) }
  const pairs = [
    ['official', 'endpoint', 'token'],
    ['selfhost', 'url', 'token'],
  ]
  for (const [block, urlKey, tokenKey] of pairs) {
    const incoming = patch?.[block]
    if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) continue
    // 新值里显式带了 token（哪怕空串）就尊重新值，别自作聪明
    if (Object.prototype.hasOwnProperty.call(incoming, tokenKey)) continue
    const existing = current?.[block]
    if (existing === null || typeof existing !== 'object') continue
    // 旧值可能在 `.token` 里，也可能还留在 URL 里（老形态），两种都要认
    const previous = splitUserToken(
      typeof existing[urlKey] === 'string' ? existing[urlKey] : '',
      typeof existing[tokenKey] === 'string' ? existing[tokenKey] : '',
    ).token
    if (previous === '') continue
    // 新地址里要是自带 token，那也轮不到这里补 —— 用户粘了新 key，让新的赢
    const urlish = typeof incoming[urlKey] === 'string' ? incoming[urlKey] : ''
    if (/[?&]userToken=/i.test(urlish)) continue
    out[block] = { ...incoming, [tokenKey]: previous }
    kept.push(`${block}.${tokenKey}`)
  }
  return { patch: out, kept }
}

/**
 * 写盘前的护栏：把带脱敏占位符的字段整条摘掉。
 *
 * **摘掉而不是报错**：面板一次提交一整块配置，只要其中一个字段是回显值，
 * 就不该连带把用户这一轮真正想改的其他项也丢掉；而那些被摘掉的项会回落
 * 到上一层（patch / 默认值）—— 对凭据而言，回落到「原来的真 token」正是
 * 用户想要的。
 *
 * @param {Record<string, unknown>} patch
 * @returns {{ patch: Record<string, unknown>, dropped: string[] }}
 */
export function guardPatch(patch) {
  const dropped = []
  const walk = (value, trail) => {
    if (hasPlaceholderToken(value) && typeof value === 'string') {
      dropped.push(trail)
      return undefined
    }
    if (Array.isArray(value)) return value.map((item, index) => walk(item, `${trail}[${index}]`))
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, child] of Object.entries(value)) {
        const next = walk(child, trail === '' ? key : `${trail}.${key}`)
        if (next !== undefined) out[key] = next
      }
      // 整块被摘空的容器也一并去掉：留个 `official: {}` 虽然无害
      // （深合并时空对象等于什么都不改），但写进配置文件会让人以为改过。
      if (Object.keys(out).length === 0 && Object.keys(value).length > 0) return undefined
      return out
    }
    return value
  }
  const clean = walk(patch ?? {}, '')
  return { patch: clean ?? {}, dropped }
}

/**
 * 从完整 URL 里拆出 userToken。
 *
 * Penpot 的鉴权模型就是把 MCP key 作为 `userToken` 查询参数带在 URL 上
 * （服务端不认 Authorization 头，见 README「鉴权真相」一节）。
 *
 * @param {string} url
 * @returns {{ url: string, token: string }} url 已去掉 userToken
 */
export function extractToken(url) {
  if (typeof url !== 'string' || url === '') return { url: '', token: '' }
  try {
    const parsed = new URL(url)
    const token = parsed.searchParams.get('userToken') ?? ''
    if (token !== '') parsed.searchParams.delete('userToken')
    return { url: parsed.toString(), token }
  } catch {
    const match = /([?&])userToken=([^&]*)/i.exec(url)
    if (match === null) return { url, token: '' }
    let token = match[2]
    try { token = decodeURIComponent(token) } catch {}
    const stripped = url.replace(/([?&])userToken=[^&]*&?/i, (whole, sep) => (sep === '?' && !whole.endsWith('&') ? '?' : '')).replace(/[?&]$/, '')
    return { url: stripped, token }
  }
}

/** 供测试用：文件名工具。 */
export const _internal = { basename }
