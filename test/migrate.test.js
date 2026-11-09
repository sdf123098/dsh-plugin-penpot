/**
 * migrate.js 的测试：导入、停用、备份、还原的完整往返。
 *
 * 关键约束（都与实测有关）：
 *   - 绝不把 token 写成 Bearer，只回写成 URL 的 userToken
 *   - 「导入 + 停用」必须先备份，且能一键还原到原样
 *   - 默认动作是「只导入」，不碰别人的配置
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'penpot-migrate-'))
process.env.DSH_HOME = join(root, 'dshhome')

const migrate = await import('../src/migrate.js')
const detect = await import('../src/detect.js')
const store = await import('../src/store.js')

function ensure(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

test('planScan 给出候选、建议动作与配置补丁', () => {
  const home = ensure(join(root, 'plan-home'))
  ensure(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), [
    '[mcp_servers.penpot]',
    'url = "http://localhost:4401/mcp"',
    '',
  ].join('\n'), 'utf8')

  const plan = migrate.planScan({ home, dshHome: join(root, 'none'), cwd: join(root, 'none') })
  assert.equal(plan.candidates.length, 1)
  const candidate = plan.candidates[0]
  assert.equal(candidate.kind, 'local')
  assert.equal(candidate.suggested, 'import-and-disable')
  assert.equal(candidate.patch.mode, 'local')
})

test('patchForCandidate 把 token 放进配置块，不放 Authorization', () => {
  const candidate = {
    source: 'codex',
    kind: 'official',
    url: 'https://design.penpot.app/mcp/stream',
    token: 'secret-key',
  }
  const patch = migrate.patchForCandidate(candidate)
  assert.equal(patch.mode, 'official')
  assert.equal(patch.official.token, 'secret-key')
  assert.equal(patch.official.endpoint, 'https://design.penpot.app/mcp/stream')
  // 不该出现任何 Authorization/Bearer 形状
  assert.equal(JSON.stringify(patch).toLowerCase().includes('bearer'), false)
  assert.equal(JSON.stringify(patch).toLowerCase().includes('authorization'), false)
})

test('exportSnippetForCandidate 把 token 拼回 URL（Penpot 只认这个）', () => {
  // 注意：这里测的是**候选**版本，不是旧的 config 版本。
  // 旧的 `exportSnippet(config)` 没有任何调用方，已经删掉了；
  // 「导出片段」这个动作真正要产出的是「那一条候选」的配置。
  const snippet = migrate.exportSnippetForCandidate({
    source: 'codex',
    name: 'penpot',
    kind: 'official',
    url: 'https://design.penpot.app/mcp/stream',
    token: 'k1',
  })
  assert.match(snippet.url, /userToken=k1/)
  assert.match(snippet.json, /mcpServers/)
  assert.match(snippet.toml, /\[mcp_servers\.penpot\]/)
})

test('exportSnippetForCandidate：本地候选给的是本机 http 地址', () => {
  const snippet = migrate.exportSnippetForCandidate({
    source: 'dsh',
    name: 'penpot',
    kind: 'local',
    command: 'node',
  })
  assert.equal(snippet.url, 'http://127.0.0.1:4401/mcp')
})

test('applyMigration：只导入时不改任何文件', () => {
  store.resetCache()
  const home = ensure(join(root, 'only-home'))
  const codexDir = ensure(join(home, '.codex'))
  const configPath = join(codexDir, 'config.toml')
  const original = '[mcp_servers.penpot]\nurl = "http://localhost:4401/mcp"\n'
  writeFileSync(configPath, original, 'utf8')

  const plan = migrate.planScan({ home, dshHome: join(root, 'none2'), cwd: join(root, 'none2') })
  const result = migrate.applyMigration({
    entries: [{ candidate: plan.candidates[0], action: 'import-only' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.backupDir, undefined)
  assert.equal(readFileSync(configPath, 'utf8'), original, '只导入必须原样不动')
  assert.equal(result.configPatch.mode, 'local')
})

test('applyMigration：导入 + 停用会备份且能还原', () => {
  store.resetCache()
  const home = ensure(join(root, 'disable-home'))
  const codexDir = ensure(join(home, '.codex'))
  const configPath = join(codexDir, 'config.toml')
  const original = [
    '# 用户注释',
    '[mcp_servers.penpot]',
    'url = "http://localhost:4401/mcp"',
    '',
    '[mcp_servers.other]',
    'url = "http://other/mcp"',
    '',
  ].join('\n')
  writeFileSync(configPath, original, 'utf8')

  const plan = migrate.planScan({ home, dshHome: join(root, 'none3'), cwd: join(root, 'none3') })
  const result = migrate.applyMigration({
    entries: [{ candidate: plan.candidates[0], action: 'import-and-disable' }],
  })
  assert.equal(result.ok, true)
  assert.notEqual(result.backupDir, undefined)
  assert.equal(existsSync(result.backupDir), true)

  const after = readFileSync(configPath, 'utf8')
  assert.match(after, /enabled = false/)
  assert.match(after, /# 用户注释/)
  assert.match(after, /\[mcp_servers\.other\]/)

  // 还原
  const restored = migrate.restoreBackup(result.backupDir)
  assert.equal(restored.ok, true)
  assert.equal(readFileSync(configPath, 'utf8'), original, '还原必须逐字节一致')
})

test('applyMigration：没有选中任何条目时报错', () => {
  const result = migrate.applyMigration({ entries: [] })
  assert.equal(result.ok, false)
  assert.match(result.error, /没有选中/)
})

test('applyMigration：多条候选时用来源最亲近的那条当配置补丁', () => {
  store.resetCache()
  const home = ensure(join(root, 'multi-home'))
  ensure(join(home, '.codex'))
  writeFileSync(join(home, '.codex', 'config.toml'), [
    '[mcp_servers.penpot]',
    'url = "https://my.penpot.example/mcp/stream?userToken=abc"',
    '',
  ].join('\n'), 'utf8')

  const plan = migrate.planScan({ home, dshHome: join(root, 'none4'), cwd: join(root, 'none4') })
  const result = migrate.applyMigration({
    entries: [{ candidate: plan.candidates[0], action: 'import-only' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.configPatch.mode, 'selfhost')
  assert.equal(result.configPatch.selfhost.token, 'abc')
})

test('applyMigration：官方档但没 token 时给出 blocker，导入仍可进行', () => {
  const candidate = {
    source: 'codex',
    kind: 'official',
    url: 'https://design.penpot.app/mcp/stream',
    token: '',
    name: 'penpot',
    path: '/x',
    args: [],
    enabled: true,
  }
  const patch = migrate.patchForCandidate(candidate)
  assert.equal(patch.mode, 'official')
  assert.equal(patch.official.token, '')
})

test('backups() 列出已有备份', () => {
  const list = migrate.backups()
  assert.ok(Array.isArray(list))
})

test('applyMigration：export-snippet 动作真的产出配置片段（之前是空操作）', () => {
  const candidate = {
    source: 'codex',
    name: 'penpot',
    kind: 'official',
    url: 'https://design.penpot.app/mcp/stream',
    token: 'abc123',
  }
  const result = migrate.applyMigration({ entries: [{ candidate, action: 'export-snippet' }] })
  assert.equal(result.ok, true)
  assert.equal(Array.isArray(result.snippets), true, '勾了「导出片段」就该有产物')
  assert.equal(result.snippets.length, 1)
  const snippet = result.snippets[0]
  assert.equal(snippet.name, 'penpot')
  assert.match(snippet.url, /userToken=abc123/)
  assert.match(snippet.json, /mcpServers/)
  assert.match(snippet.toml, /\[mcp_servers\.penpot\]/)
})

test('applyMigration：只导入不该产出片段', () => {
  const candidate = { source: 'cursor', name: 'penpot', kind: 'official', url: 'https://x.test/mcp/stream', token: '' }
  const result = migrate.applyMigration({ entries: [{ candidate, action: 'import-only' }] })
  assert.equal(result.snippets, undefined)
})
