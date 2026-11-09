/**
 * 三种配置格式的读写：JSON / TOML / YAML（行式）。
 *
 * 为什么 YAML 用「行式」而不是通用解析器：
 *   1. DSH 的 `cordis.patch.yml` 里带 `!!js` 自定义标签，通用解析器会直接抛；
 *   2. 我们改它时**必须保留注释和缩进**（用户手写的部署文件），行式改动能做到，
 *      结构化 round-trip 不能；
 *   3. 我们需要的字段很浅（id / name / command / args / url / serverName），
 *      行式块解析足够且没有依赖。
 *
 * TOML 同理：Codex 的 config.toml 有大量注释和嵌套表，行式定位 section 再改
 * 一行，比引入 TOML 库更安全（也更小）。
 *
 * @module dsh-plugin-penpot/formats
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** 探测到的一条 penpot 配置。 */
export const SOURCE_LABELS = {
  dsh: 'DSH 插件配置',
  codex: 'Codex',
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  project: '项目级配置',
  unknown: '未知来源',
}

/**
 * 读一个 JSON 文件，容忍注释（jsonc）与 BOM。
 *
 * @param {string} file
 * @returns {{ ok: true, value: any, text: string } | { ok: false, error: string }}
 */
export function readJsonFile(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const stripped = text.replace(/^\uFEFF/, '')
  try {
    return { ok: true, value: JSON.parse(stripped), text: stripped }
  } catch {
    // 带注释的 JSON（.vscode/mcp.json 常见）：尽量剥掉行注释再试一次。
    const withoutComments = stripped
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    try {
      return { ok: true, value: JSON.parse(withoutComments), text: stripped }
    } catch (error) {
      return { ok: false, error: `JSON 解析失败：${String(error?.message ?? error)}` }
    }
  }
}

/** 写回 JSON（保留 2 空格缩进；这是这些客户端的共同风格）。 */
export function writeJsonFile(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/**
 * 从一行 JSON 文本里猜出某个 server 条目的行号（只用于展示溯源）。
 *
 * @param {string} text
 * @param {string} name
 */
export function findJsonLine(text, name) {
  const lines = String(text ?? '').split(/\r?\n/)
  const needle = new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`)
  for (let i = 0; i < lines.length; i++) {
    if (needle.test(lines[i])) return i + 1
  }
  return undefined
}

/**
 * 解析 TOML 里所有 `[mcp_servers.<name>]` 段落。
 *
 * 支持的行形式：
 *   [mcp_servers.penpot]            ← 表头（也支持带引号 "penpot"）
 *   url = "http://..."
 *   command = "node"
 *   args = ["a", "b"]
 *   enabled = false
 *   env = { KEY = "value" }
 *
 * @param {string} file
 * @returns {{ ok: true, servers: Array<{ name: string, headerLine: number, url?: string, command?: string, args: string[], enabled?: boolean, transport?: string }>, text: string } | { ok: false, error: string }}
 */
export function readTomlMcpServers(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const lines = text.split(/\r?\n/)
  const servers = []
  let current
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const header = /^\s*\[mcp_servers\.(?:"([^"]+)"|([^\]\s]+))\]\s*(?:#.*)?$/.exec(line)
    if (header !== null) {
      current = {
        name: header[1] ?? header[2],
        headerLine: i + 1,
        args: [],
      }
      servers.push(current)
      continue
    }
    // 任何其他表头都结束当前段
    if (/^\s*\[/.test(line)) { current = undefined; continue }
    if (current === undefined) continue
    const kv = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const raw = kv[2]
    if (key === 'url' || key === 'command') {
      current[key] = unquoteTomlString(raw)
    } else if (key === 'args') {
      current.args = parseTomlArray(raw)
    } else if (key === 'enabled') {
      current.enabled = raw.trim() !== 'false'
    } else if (key === 'transport') {
      current.transport = unquoteTomlString(raw)
    }
  }
  return { ok: true, servers, text }
}

function unquoteTomlString(raw) {
  const text = String(raw ?? '').trim()
  const match = /^(?:'([\s\S]*)'|"([\s\S]*)")/.exec(text)
  if (match !== null) return (match[1] ?? match[2] ?? '').replace(/\\(["\\])/g, '$1')
  return text.split(/\s+#/)[0].trim()
}

/** 解析 `["a", "b"]` 这类单行数组。 */
export function parseTomlArray(raw) {
  const text = String(raw ?? '')
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  const inner = text.slice(start + 1, end)
  const out = []
  const re = /(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g
  let match
  while ((match = re.exec(inner)) !== null) {
    out.push((match[1] ?? match[2] ?? '').replace(/\\(["\\])/g, '$1'))
  }
  return out
}

/**
 * 在 TOML 里把一个 `[mcp_servers.<name>]` 段落标记为停用。
 *
 * Codex 认 `enabled = false`（`codex mcp list` 里能看到 Status 变 disabled），
 * 所以这是最干净的就地停用方式：改一行、可逆、不动别的内容。
 *
 * @param {string} file
 * @param {string} name
 * @returns {{ ok: true, before: string, after: string } | { ok: false, error: string }}
 */
export function disableTomlServer(file, name) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const before = text
  const lines = text.split(/\r?\n/)
  const headerRe = /^\s*\[mcp_servers\.(?:"([^"]+)"|([^\]\s]+))\]\s*(?:#.*)?$/
  let headerIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const match = headerRe.exec(lines[i])
    if (match !== null && (match[1] ?? match[2]) === name) { headerIndex = i; break }
  }
  if (headerIndex < 0) return { ok: false, error: `在 ${file} 里找不到 [mcp_servers.${name}]` }

  // 段落到下一个表头为止
  let endIndex = lines.length
  for (let i = headerIndex + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { endIndex = i; break }
  }
  // 已有 enabled = false 就只回报，不重复插入
  for (let i = headerIndex + 1; i < endIndex; i++) {
    if (/^\s*enabled\s*=\s*false\s*(?:#.*)?$/.test(lines[i])) {
      return { ok: true, before, after: before }
    }
    if (/^\s*enabled\s*=/.test(lines[i])) {
      const updated = lines.slice()
      updated[i] = 'enabled = false'
      const after = updated.join('\n')
      writeFileSync(file, after, 'utf8')
      return { ok: true, before, after }
    }
  }
  // 插在表头之后，保留原有空行风格
  const updated = lines.slice()
  updated.splice(headerIndex + 1, 0, 'enabled = false')
  const after = updated.join('\n')
  writeFileSync(file, after, 'utf8')
  return { ok: true, before, after }
}

/**
 * 读 YAML（行式）：抽出所有补丁条目，并记录它们占用的行范围。
 *
 * 认识的形状（cordis.patch.yml 的 insert 列表）：
 *   - insert:
 *       - id: mcp-lazy-penpot
 *         name: '@sutong12/dsh-mcp-lazy'
 *         config:
 *           serverName: penpot
 *           command: '...'
 *           args:
 *             - '...'
 *           url: 'https://...'
 *
 * @param {string} file
 * @returns {{ ok: true, entries: Array<{ id: string, name: string, startLine: number, endLine: number, config: Record<string, unknown>, fields: Record<string, string>, args: string[] }>, text: string } | { ok: false, error: string }}
 */
export function readYamlPatchEntries(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const lines = text.split(/\r?\n/)
  const entries = []
  let current
  let listItemIndent = -1

  const close = (endLine) => {
    if (current !== undefined) {
      current.endLine = endLine
      entries.push(current)
      current = undefined
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 列表项起始：`  - id: xxx`（缩进后跟 `- id:`）
    const itemStart = /^(\s*)-\s+id:\s*(.+?)\s*$/.exec(line)
    if (itemStart !== null) {
      close(i) // 上一项结束于本行之前
      listItemIndent = itemStart[1].length
      current = {
        id: stripYamlScalar(itemStart[2]),
        name: '',
        startLine: i + 1,
        endLine: lines.length,
        config: {},
        fields: {},
        args: [],
        indent: listItemIndent,
      }
      continue
    }
    if (current === undefined) continue
    // 同级或更浅的列表项 → 本项结束
    if (/^\s*-/.test(line) && line.search(/\S/) <= listItemIndent) {
      close(i)
      continue
    }
    const kv = /^\s*([A-Za-z0-9_.-]+):\s*(.*?)\s*$/.exec(line)
    if (kv !== null) {
      const key = kv[1]
      const value = kv[2]
      if (key === 'name' && current.name === '') current.name = stripYamlScalar(value)
      else current.fields[key] = stripYamlScalar(value)
      continue
    }
    const argLine = /^\s*-\s+(.+?)\s*$/.exec(line)
    if (argLine !== null) {
      const previousKey = lastKey(lines, i)
      if (previousKey === 'args') current.args.push(stripYamlScalar(argLine[1]))
      continue
    }
  }
  close(lines.length)
  return { ok: true, entries, text }
}

/** 往上找一个 key: 行（args 数组的归属）。 */
function lastKey(lines, index) {
  for (let i = index - 1; i >= 0 && i > index - 8; i--) {
    const kv = /^\s*([A-Za-z0-9_.-]+):\s*(.*?)\s*$/.exec(lines[i])
    if (kv !== null) return kv[2].trim() === '' ? kv[1] : undefined
  }
  return undefined
}

/** 去掉 YAML 标量的引号与行尾注释。 */
export function stripYamlScalar(raw) {
  const text = String(raw ?? '').trim()
  if (text.startsWith("'") || text.startsWith('"')) {
    const quote = text[0]
    const end = text.indexOf(quote, 1)
    if (end > 0) return text.slice(1, end)
    return text.slice(1)
  }
  const hash = text.indexOf(' #')
  return (hash >= 0 ? text.slice(0, hash) : text).trim()
}

/**
 * 把 YAML 里某个条目整段注释掉（就地停用）。
 *
 * 逐行加 `# ` 前缀，而不是删行：注释保留原文、用户看得见改了什么，
 * 而且还原就是把前缀去掉 —— 比结构化重写安全得多。
 *
 * @param {string} file
 * @param {{ startLine: number, endLine: number }} entry 1-based，含端点
 * @returns {{ ok: true, before: string, after: string } | { ok: false, error: string }}
 */
export function commentYamlEntry(file, entry) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const before = text
  const lines = text.split(/\r?\n/)
  const from = Math.max(0, entry.startLine - 1)
  // endLine 是「下一项的前一行」，注意留出块后可能存在的空行
  let to = Math.min(lines.length - 1, entry.endLine - 1)
  while (to > from && lines[to].trim() === '') to--

  const already = lines.slice(from, to + 1).every((line) => line.trim() === '' || /^\s*#/.test(line))
  if (already) return { ok: true, before, after: before }

  for (let i = from; i <= to; i++) {
    if (lines[i].trim() === '') continue
    const indent = /^\s*/.exec(lines[i])[0]
    lines[i] = `${indent}# [dsh-plugin-penpot 已停用] ${lines[i].slice(indent.length)}`
  }
  const after = lines.join('\n')
  writeFileSync(file, after, 'utf8')
  return { ok: true, before, after }
}

/**
 * 读一个 JSON 里的 `mcpServers` / `servers` 映射。
 *
 * @param {string} file
 * @returns {{ ok: true, servers: Array<{ name: string, value: Record<string, unknown>, line?: number }>, text: string, containerKey: string } | { ok: false, error: string }}
 */
export function readJsonMcpServers(file) {
  const read = readJsonFile(file)
  if (!read.ok) return { ok: false, error: read.error }
  const value = read.value
  const containerKey = ['mcpServers', 'servers', 'mcp_servers'].find(
    (key) => value !== null && typeof value === 'object' && value[key] !== null && typeof value[key] === 'object',
  )
  if (containerKey === undefined) return { ok: false, error: '没有 mcpServers / servers 段' }
  const servers = Object.entries(value[containerKey]).map(([name, entryValue]) => ({
    name,
    value: entryValue !== null && typeof entryValue === 'object' ? entryValue : {},
    line: findJsonLine(read.text, name),
  }))
  return { ok: true, servers, text: read.text, containerKey }
}

/**
 * 在 JSON 里停用一个 server：优先 `disabled: true`，不支持时删掉该条目。
 *
 * @param {string} file
 * @param {string} name
 * @param {{ removeEntry?: boolean }} [options]
 * @returns {{ ok: true, before: string, after: string, mode: 'disabled' | 'removed' } | { ok: false, error: string }}
 */
export function disableJsonServer(file, name, options = {}) {
  const read = readJsonFile(file)
  if (!read.ok) return { ok: false, error: read.error }
  const value = read.value
  const containerKey = ['mcpServers', 'servers', 'mcp_servers'].find(
    (key) => value !== null && typeof value === 'object' && value[key] !== null && typeof value[key] === 'object',
  )
  if (containerKey === undefined) return { ok: false, error: '没有 mcpServers / servers 段' }
  const entry = value[containerKey][name]
  if (entry === undefined) return { ok: false, error: `找不到 ${containerKey}.${name}` }
  const before = read.text
  if (options.removeEntry === true) {
    delete value[containerKey][name]
    writeJsonFile(file, value)
    return { ok: true, before, after: readFileSync(file, 'utf8'), mode: 'removed' }
  }
  const next = entry !== null && typeof entry === 'object' ? { ...entry, disabled: true } : { disabled: true }
  value[containerKey][name] = next
  writeJsonFile(file, value)
  return { ok: true, before, after: readFileSync(file, 'utf8'), mode: 'disabled' }
}
