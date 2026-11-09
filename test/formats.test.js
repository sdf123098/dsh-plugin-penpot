/**
 * formats.js 的测试：TOML / YAML / JSON 三种配置的读与就地停用。
 *
 * 这些解析器是**行式**的（不是通用解析器），所以测试要钉住：
 *   - 能读出真实文件里的 penpot 段
 *   - 停用只动那一行/那一段，别的东西一字不改
 *   - 注释与缩进保留
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  disableJsonServer,
  disableTomlServer,
  commentYamlEntry,
  readJsonMcpServers,
  readTomlMcpServers,
  readYamlPatchEntries,
  parseTomlArray,
  stripYamlScalar,
} from '../src/formats.js'

const dir = mkdtempSync(join(tmpdir(), 'penpot-formats-'))

function tmpFile(name, content) {
  const file = join(dir, name)
  writeFileSync(file, content, 'utf8')
  return file
}

test('TOML：读出 mcp_servers 各段的名字与字段', () => {
  const file = tmpFile('config.toml', [
    'model = "gpt"',
    '',
    '[mcp_servers.penpot]',
    'url = "http://localhost:4401/mcp"',
    '',
    '[mcp_servers.windows-mcp]',
    'startup_timeout_sec = 120',
    'command = "D:/Tools/windows-mcp.exe"',
    'args = ["serve"]',
    '',
    '[windows]',
    'sandbox = "elevated"',
    '',
  ].join('\n'))
  const read = readTomlMcpServers(file)
  assert.equal(read.ok, true)
  assert.equal(read.servers.length, 2)
  const penpot = read.servers.find(server => server.name === 'penpot')
  assert.equal(penpot.url, 'http://localhost:4401/mcp')
  assert.equal(penpot.headerLine, 3)
  const windows = read.servers.find(server => server.name === 'windows-mcp')
  assert.deepEqual(windows.args, ['serve'])
})

test('TOML：带引号的表名与单引号字符串', () => {
  const file = tmpFile('quoted.toml', [
    '[mcp_servers."my-penpot"]',
    "url = 'https://penpot.example.com/mcp/stream'",
    '',
  ].join('\n'))
  const read = readTomlMcpServers(file)
  assert.equal(read.servers[0].name, 'my-penpot')
  assert.equal(read.servers[0].url, 'https://penpot.example.com/mcp/stream')
})

test('TOML：停用只插入 enabled = false，其他行一字不改', () => {
  const original = [
    '# 顶部注释',
    '[mcp_servers.penpot]',
    'url = "http://localhost:4401/mcp"',
    '',
    '[mcp_servers.other]',
    'url = "http://x/mcp"',
    '',
  ].join('\n')
  const file = tmpFile('disable.toml', original)
  const result = disableTomlServer(file, 'penpot')
  assert.equal(result.ok, true)
  const after = readFileSync(file, 'utf8')
  assert.match(after, /\[mcp_servers\.penpot\]\nenabled = false\nurl = "http:\/\/localhost:4401\/mcp"/)
  assert.match(after, /# 顶部注释/)
  assert.match(after, /\[mcp_servers\.other\]/)
  // other 段没被插入
  assert.equal(after.split('enabled = false').length, 2)
})

test('TOML：已存在 enabled = true 时就地改成 false，不重复插入', () => {
  const file = tmpFile('existing.toml', [
    '[mcp_servers.penpot]',
    'enabled = true',
    'url = "http://localhost:4401/mcp"',
    '',
  ].join('\n'))
  disableTomlServer(file, 'penpot')
  const after = readFileSync(file, 'utf8')
  assert.equal((after.match(/enabled\s*=/g) ?? []).length, 1)
  assert.match(after, /enabled = false/)
})

test('TOML：停用不存在的段返回错误而不是抛', () => {
  const file = tmpFile('missing.toml', '[mcp_servers.other]\nurl = "x"\n')
  const result = disableTomlServer(file, 'penpot')
  assert.equal(result.ok, false)
  assert.match(result.error, /找不到/)
})

test('parseTomlArray 支持单引号、转义与多元素', () => {
  assert.deepEqual(parseTomlArray('["a", "b"]'), ['a', 'b'])
  assert.deepEqual(parseTomlArray("['a', 'b']"), ['a', 'b'])
  assert.deepEqual(parseTomlArray('["a\\"b"]'), ['a"b'])
  assert.deepEqual(parseTomlArray('[]'), [])
})

test('YAML：读出 insert 列表里每个条目的 id/name/字段/行范围', () => {
  const file = tmpFile('patch.yml', [
    '# 注释',
    '- insert:',
    '    - id: mcp-lazy-penpot',
    "      name: '@sutong12/dsh-mcp-lazy'",
    '      config:',
    '        transport: stdio',
    '        serverName: penpot',
    "        command: 'D:\\Program Files\\nodejs\\node.exe'",
    '        args:',
    "          - 'C:\\penpot\\bridge.mjs'",
    '        releaseOnTurnEnd: false',
    '',
    '    - id: other',
    "      name: 'x'",
    '',
  ].join('\n'))
  const read = readYamlPatchEntries(file)
  assert.equal(read.ok, true)
  assert.equal(read.entries.length, 2)
  const penpot = read.entries[0]
  assert.equal(penpot.id, 'mcp-lazy-penpot')
  assert.equal(penpot.name, '@sutong12/dsh-mcp-lazy')
  assert.equal(penpot.fields.serverName, 'penpot')
  assert.equal(penpot.fields.transport, 'stdio')
  assert.deepEqual(penpot.args, ['C:\\penpot\\bridge.mjs'])
  assert.equal(penpot.startLine, 3)
})

test('YAML：注释条目不删行，保留原文可逆', () => {
  const original = [
    '- insert:',
    '    - id: mcp-lazy-penpot',
    "      name: 'x'",
    '      config:',
    '        serverName: penpot',
    '',
    '    - id: other',
    "      name: 'y'",
    '',
  ].join('\n')
  const file = tmpFile('comment.yml', original)
  const read = readYamlPatchEntries(file)
  const target = read.entries[0]
  const result = commentYamlEntry(file, target)
  assert.equal(result.ok, true)
  const after = readFileSync(file, 'utf8')
  // 原来的行都还在，只是前面多了注释标记
  assert.match(after, /# \[dsh-plugin-penpot 已停用\] - id: mcp-lazy-penpot/)
  assert.match(after, /other/)
  // 缩进被保留（4 空格）
  assert.match(after, /^ {4}# \[dsh-plugin-penpot 已停用\] - id: mcp-lazy-penpot$/m)
  // 其他条目没被注释
  assert.match(after, /^ {4}- id: other$/m)
})

test('YAML：重复注释是幂等的', () => {
  const file = tmpFile('idempotent.yml', [
    '- insert:',
    '    - id: only',
    "      name: 'x'",
    '',
  ].join('\n'))
  const entry = readYamlPatchEntries(file).entries[0]
  commentYamlEntry(file, entry)
  const once = readFileSync(file, 'utf8')
  commentYamlEntry(file, entry)
  const twice = readFileSync(file, 'utf8')
  assert.equal(once, twice)
})

test('stripYamlScalar 处理引号与行尾注释', () => {
  assert.equal(stripYamlScalar("'abc'"), 'abc')
  assert.equal(stripYamlScalar('"abc"'), 'abc')
  assert.equal(stripYamlScalar('abc # comment'), 'abc')
  assert.equal(stripYamlScalar('  plain  '), 'plain')
})

test('JSON：读出 mcpServers 映射与行号', () => {
  const file = tmpFile('mcp.json', JSON.stringify({
    mcpServers: {
      penpot: { type: 'http', url: 'http://localhost:4401/mcp' },
      other: { command: 'node' },
    },
  }, null, 2))
  const read = readJsonMcpServers(file)
  assert.equal(read.ok, true)
  assert.equal(read.containerKey, 'mcpServers')
  assert.equal(read.servers.length, 2)
  const penpot = read.servers.find(server => server.name === 'penpot')
  assert.equal(penpot.value.url, 'http://localhost:4401/mcp')
  assert.equal(typeof penpot.line, 'number')
})

test('JSON：停用以 disabled: true 写入，其余条目不动', () => {
  const file = tmpFile('disable.json', JSON.stringify({
    mcpServers: {
      penpot: { url: 'http://localhost:4401/mcp' },
      other: { command: 'node' },
    },
  }, null, 2))
  const result = disableJsonServer(file, 'penpot')
  assert.equal(result.ok, true)
  assert.equal(result.mode, 'disabled')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.mcpServers.penpot.disabled, true)
  assert.equal(parsed.mcpServers.penpot.url, 'http://localhost:4401/mcp')
  assert.deepEqual(parsed.mcpServers.other, { command: 'node' })
})

test('JSON：removeEntry 时整条删掉', () => {
  const file = tmpFile('remove.json', JSON.stringify({
    mcpServers: { penpot: { url: 'x' }, other: { command: 'node' } },
  }, null, 2))
  const result = disableJsonServer(file, 'penpot', { removeEntry: true })
  assert.equal(result.mode, 'removed')
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(parsed.mcpServers.penpot, undefined)
  assert.deepEqual(parsed.mcpServers.other, { command: 'node' })
})

test('JSON：带注释的 jsonc 也能读', () => {
  const file = tmpFile('jsonc.json', [
    '{',
    '  // 注释行',
    '  "mcpServers": {',
    '    "penpot": { "url": "http://localhost:4401/mcp" }',
    '  }',
    '}',
  ].join('\n'))
  const read = readJsonMcpServers(file)
  assert.equal(read.ok, true)
  assert.equal(read.servers[0].name, 'penpot')
})
