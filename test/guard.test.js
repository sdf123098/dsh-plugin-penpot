/**
 * 脱敏占位符护栏的测试。
 *
 * 背景（真事故）：面板把后端回显的脱敏端点 `…?userToken=***` 填进输入框，
 * 用户点「保存」就把占位符写回磁盘，覆盖掉真凭据。这组测试盯住那道护栏。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { guardPatch, hasPlaceholderToken, REDACTED_PLACEHOLDER, redactUrl } from '../src/store.js'

test('redactUrl 把 userToken 换成占位符，其他参数保留', () => {
  const redacted = redactUrl('https://design.penpot.app/mcp/stream?userToken=secret123&x=1')
  assert.match(redacted, /userToken=\*\*\*/)
  assert.equal(redacted.includes('secret123'), false)
  assert.match(redacted, /x=1/, '别的查询参数不该被吃掉')
})

test('hasPlaceholderToken 认得占位符形态', () => {
  assert.equal(hasPlaceholderToken('https://a/mcp/stream?userToken=***'), true)
  assert.equal(hasPlaceholderToken('***'), true)
  assert.equal(hasPlaceholderToken('https://a/mcp/stream?userToken=real-key'), false)
  assert.equal(hasPlaceholderToken(''), false)
  // 正常文案里的三个星号不该被误伤
  assert.equal(hasPlaceholderToken('这段文字里有 *** 但不是占位符'), false)
})

test('guardPatch 摘掉带占位符的字段，其余字段保留', () => {
  const { patch, dropped } = guardPatch({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream?userToken=***' },
    local: { httpPort: 4401 },
  })
  assert.equal(patch.mode, 'official', '别的好字段必须留下')
  assert.equal(patch.official, undefined, '带占位符的整条要摘掉')
  assert.deepEqual(patch.local, { httpPort: 4401 })
  assert.deepEqual(dropped, ['official.endpoint'])
})

test('guardPatch 对干净配置原样返回', () => {
  const input = { mode: 'local', local: { httpPort: 4402, repoDir: 'C:\\x' } }
  const { patch, dropped } = guardPatch(input)
  assert.deepEqual(patch, input)
  assert.deepEqual(dropped, [])
})

test('guardPatch 不碰非字符串的布尔/数字', () => {
  const { patch } = guardPatch({ requireApproval: false, connectTimeoutMs: 0, pat: { reuseMcpKey: false } })
  assert.equal(patch.requireApproval, false)
  assert.equal(patch.connectTimeoutMs, 0)
  assert.deepEqual(patch.pat, { reuseMcpKey: false })
})

test('占位符常量与 redactUrl 用的是同一个值', () => {
  assert.equal(REDACTED_PLACEHOLDER, '***')
  assert.ok(redactUrl('https://a/mcp/stream?userToken=x').includes(REDACTED_PLACEHOLDER))
})
