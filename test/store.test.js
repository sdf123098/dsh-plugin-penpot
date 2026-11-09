/**
 * store.js 的测试：覆盖文本脱敏、token 抽取、备份/还原、覆盖层合并。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// store 的数据目录由 DSH_HOME 决定，测试前先钉一个临时目录
const home = mkdtempSync(join(tmpdir(), 'penpot-store-'))
process.env.DSH_HOME = home

const store = await import('../src/store.js')

test('maskToken 永不回显真值', () => {
  assert.deepEqual(store.maskToken(''), { configured: false })
  const masked = store.maskToken('sk-abcdef123456789')
  assert.equal(masked.configured, true)
  assert.equal(masked.preview, '…6789')
  assert.equal(masked.length, 18)
  assert.equal(JSON.stringify(masked).includes('abcdef123456'), false)
})

test('redactUrl 把 userToken 打掉但保留其他参数', () => {
  const redacted = store.redactUrl('https://design.penpot.app/mcp/stream?userToken=secret&x=1')
  assert.equal(redacted.includes('secret'), false)
  assert.equal(redacted.includes('x=1'), true)
})

test('extractToken 从 URL 里拆出 userToken 并从 URL 移除', () => {
  const result = store.extractToken('https://design.penpot.app/mcp/stream?userToken=abc%2Fdef&x=1')
  assert.equal(result.token, 'abc/def')
  assert.equal(result.url.includes('userToken'), false)
  assert.equal(result.url.includes('x=1'), true)
})

test('extractToken 对没有 token 的 URL 原样返回', () => {
  const result = store.extractToken('http://localhost:4401/mcp')
  assert.equal(result.token, '')
  assert.equal(result.url, 'http://localhost:4401/mcp')
})

test('writeOverrides 与 readOverrides 往返，undefined 表示删除', () => {
  store.resetCache()
  const written = store.writeOverrides({ mode: 'local', local: { httpPort: 4511 } })
  assert.equal(written.ok, true)
  store.resetCache()
  const read = store.readOverrides()
  assert.equal(read.mode, 'local')
  assert.equal(read.local.httpPort, 4511)

  store.writeOverrides({ mode: undefined })
  store.resetCache()
  assert.equal(store.readOverrides().mode, undefined)
})

test('writeOverrides 对嵌套对象做深合并', () => {
  store.resetCache()
  store.writeOverrides({ local: { repoDir: 'D:/penpot' } })
  store.writeOverrides({ local: { httpPort: 4600 } })
  store.resetCache()
  const read = store.readOverrides()
  assert.equal(read.local.repoDir, 'D:/penpot')
  assert.equal(read.local.httpPort, 4600)
})

test('writeDetected 记录时间戳与候选', () => {
  store.resetCache()
  const written = store.writeDetected({ picked: 'local', from: 'codex:config.toml:50', rationale: 'ok', candidates: [{ name: 'penpot' }] })
  assert.equal(written.picked, 'local')
  assert.equal(written.candidates.length, 1)
  assert.match(written.pickedAt, /^\d{4}-\d{2}-\d{2}T/)
  store.resetCache()
  assert.equal(store.readDetected().picked, 'local')
})

test('备份：创建目录、拷文件、manifest 可读、可删除', () => {
  const dir = store.createBackupDir()
  assert.equal(existsSync(dir), true)
  const source = join(home, 'sample.toml')
  writeFileSync(source, 'x = 1\n', 'utf8')
  const backupPath = store.backupFile(dir, source)
  assert.notEqual(backupPath, undefined)
  assert.equal(readFileSync(backupPath, 'utf8'), 'x = 1\n')

  store.writeBackupManifest(dir, { createdAt: '2026-01-01T00:00:00.000Z', entries: [{ source: 'codex', name: 'penpot' }] })
  const listed = store.listBackups()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].entries, 1)
  assert.deepEqual(listed[0].summary, ['codex:penpot'])

  assert.equal(store.readBackupManifest(dir).createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(store.removeBackup(dir), true)
  assert.equal(store.listBackups().length, 0)
})

test('mergeDeep 递归合并，数组整体替换', () => {
  const out = store.mergeDeep({ a: { b: 1, c: [1, 2] } }, { a: { c: [3] } })
  assert.deepEqual(out, { a: { b: 1, c: [3] } })
})
