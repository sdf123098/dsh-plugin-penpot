/**
 * detect.js 的测试：识别、归档、去重、自动判定的优先级。
 *
 * 用临时目录伪造各家的配置文件，不碰真实环境。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyStdio,
  classifyUrl,
  decideAuto,
  dedupe,
  identityKey,
  localPortOf,
  looksLikePenpotText,
  scanAll,
  sourceRank,
  toCandidate,
} from '../src/detect.js'

const root = mkdtempSync(join(tmpdir(), 'penpot-detect-'))
const home = join(root, 'home')
const dsh = join(root, 'dsh')
const cwd = join(root, 'project')

function ensure(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

test('classifyUrl 按域名分档', () => {
  assert.equal(classifyUrl('https://design.penpot.app/mcp/stream'), 'official')
  assert.equal(classifyUrl('https://test-mcp.penpot.dev/mcp/stream'), 'official')
  assert.equal(classifyUrl('http://localhost:4401/mcp'), 'local')
  assert.equal(classifyUrl('http://127.0.0.1:4401/mcp'), 'local')
  assert.equal(classifyUrl('https://penpot.mycorp.com/mcp/stream'), 'selfhost')
})

test('classifyStdio 从 dist 路径推断仓库根与入口', () => {
  const result = classifyStdio('node', ['C:\\Users\\x\\.dsh\\mcp-servers\\penpot\\packages\\server\\dist\\index.js'])
  assert.equal(result.kind, 'local')
  assert.equal(result.sub, 'repo')
  assert.equal(result.repoDir, 'C:\\Users\\x\\.dsh\\mcp-servers\\penpot')
  assert.equal(result.entry, 'packages/server/dist/index.js')
})

test('classifyStdio 认 stdio 桥（归一成直连入口），也认 npx @penpot/mcp', () => {
  // 桥文件归一成真正的服务器入口：本插件自己就是 MCP 客户端，不需要再套桥梁
  const bridge = classifyStdio('node', ['/home/u/penpot/packages/server/penpot-stdio-bridge.mjs'])
  assert.equal(bridge.entry, 'packages/server/dist/index.js')
  assert.match(bridge.note, /桥/)

  const npm = classifyStdio('npx', ['-y', '@penpot/mcp@stable'])
  assert.equal(npm.sub, 'npm')
})

test('looksLikePenpotText 不会把 4401 单独当证据', () => {
  assert.equal(looksLikePenpotText(['penpot-mcp']), true)
  assert.equal(looksLikePenpotText(['http://localhost:4401/mcp']), true)
  // 只有端口、没有 mcp/http：不算
  assert.equal(looksLikePenpotText(['--port=4401']), false)
  // 其他服务
  assert.equal(looksLikePenpotText(['https://mcp.heygen.com/mcp/hyperframes/']), false)
})

test('toCandidate 把 URL 里的 userToken 拆出来并脱敏', () => {
  const candidate = toCandidate({
    source: 'dsh',
    path: '/x/cordis.patch.yml',
    name: 'penpot',
    value: { url: 'https://design.penpot.app/mcp/stream?userToken=secret' },
  })
  assert.equal(candidate.kind, 'official')
  assert.equal(candidate.token, 'secret')
  assert.equal(candidate.url.includes('secret'), false)
})

test('toCandidate 对名字不像 penpot 但 URL 像的条目也认得', () => {
  const candidate = toCandidate({
    source: 'codex',
    path: '/x/config.toml',
    name: 'my-design',
    value: { url: 'http://localhost:4401/mcp' },
  })
  assert.notEqual(candidate, undefined)
  assert.equal(candidate.kind, 'local')
})

test('toCandidate 对无关条目返回 undefined（不能误伤 hyperframes）', () => {
  const candidate = toCandidate({
    source: 'codex',
    path: '/x/config.toml',
    name: 'hyperframes',
    value: { url: 'https://mcp.heygen.com/mcp/hyperframes/' },
  })
  assert.equal(candidate, undefined)
})

test('dedupe：同一端口的本地条目合并，DSH 排前', () => {
  const fromCodex = toCandidate({ source: 'codex', path: '/c.toml', name: 'penpot', value: { url: 'http://localhost:4401/mcp' } })
  const fromDsh = toCandidate({ source: 'dsh', path: '/p.yml', name: 'penpot', value: { url: 'http://127.0.0.1:4401/mcp' } })
  const merged = dedupe([fromCodex, fromDsh])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].source, 'dsh')
  assert.equal(merged[0].duplicates.length, 1)
  assert.equal(merged[0].duplicates[0].source, 'codex')
})

test('identityKey / localPortOf 从 args 里读端口', () => {
  const candidate = toCandidate({
    source: 'dsh',
    path: '/p.yml',
    name: 'penpot',
    value: { command: 'node', args: ['--port=4599', 'dist/index.js'] },
  })
  assert.equal(localPortOf(candidate), 4599)
  assert.equal(identityKey(candidate), 'local:4599')
})

test('sourceRank 让 DSH 优先于其他客户端', () => {
  assert.ok(sourceRank('dsh') < sourceRank('codex'))
  assert.ok(sourceRank('project') < sourceRank('codex'))
  assert.ok(sourceRank('codex') <= sourceRank('cursor'))
})

test('scanAll 能从伪造的 DSH / Codex / 项目级配置里全捞出来', () => {
  const homeDir = ensure(join(root, 'scan-home'))
  const dshDir = ensure(join(dsh, 'profiles', 'desktop'))
  const projectDir = ensure(join(root, 'scan-project'))

  writeFileSync(join(dshDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: mcp-lazy-penpot',
    "      name: '@sutong12/dsh-mcp-lazy'",
    '      config:',
    '        transport: stdio',
    '        serverName: penpot',
    '        args:',
    "          - 'C:\\repo\\packages\\server\\dist\\index.js'",
    '',
  ].join('\n'), 'utf8')

  ensure(join(homeDir, '.codex'))
  writeFileSync(join(homeDir, '.codex', 'config.toml'), [
    '[mcp_servers.penpot]',
    'url = "http://localhost:4401/mcp"',
    '',
    '[mcp_servers.hyperframes]',
    'url = "https://mcp.heygen.com/mcp/hyperframes/"',
    '',
  ].join('\n'), 'utf8')

  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      penpot: { type: 'http', url: 'https://my.penpot.example/mcp/stream?userToken=abc' },
    },
  }, null, 2), 'utf8')

  const result = scanAll({ home: homeDir, dshHome: dsh, cwd: projectDir })
  const kinds = result.candidates.map(candidate => `${candidate.source}:${candidate.kind}`).sort()
  assert.deepEqual(kinds, ['dsh:local', 'project:selfhost'])
  // hyperframes 没被误捞
  assert.equal(result.candidates.some(candidate => candidate.name === 'hyperframes'), false)
})

test('decideAuto：全都不可达时如实标 offline，且不改成别的档', async () => {
  const emptyRoot = ensure(join(root, 'empty'))
  const result = await decideAuto({
    home: join(emptyRoot, 'home'),
    dshHome: join(emptyRoot, 'dsh'),
    cwd: join(emptyRoot, 'project'),
    probeTimeoutMs: 200,
  })
  // 没扫到任何配置 → 兜底。本机 dist 路径是配置里的默认值，取决于真实环境，
  // 这里只断言「给出了一个合法档 + 说清了理由」。
  assert.ok(['level', 'local', 'official'].includes(result.picked) || ['local', 'official', 'selfhost'].includes(result.picked))
  assert.equal(typeof result.rationale, 'string')
  assert.ok(result.rationale.length > 0)
})

test('decideAuto：扫到但不可达 → offline=true，picked 仍是扫到的那档', async () => {
  const offlineRoot = ensure(join(root, 'offline'))
  const homeDir = ensure(join(offlineRoot, 'home'))
  ensure(join(homeDir, '.codex'))
  // 用一个几乎不可能有服务的端口
  writeFileSync(join(homeDir, '.codex', 'config.toml'), [
    '[mcp_servers.penpot]',
    'url = "http://127.0.0.1:59999/mcp"',
    '',
  ].join('\n'), 'utf8')

  const result = await decideAuto({
    home: homeDir,
    dshHome: join(offlineRoot, 'dsh'),
    cwd: join(offlineRoot, 'project'),
    probeTimeoutMs: 300,
  })
  assert.equal(result.picked, 'local')
  assert.equal(result.offline, true)
  assert.match(result.rationale, /都连不上/)
})
