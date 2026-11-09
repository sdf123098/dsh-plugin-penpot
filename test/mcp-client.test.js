/**
 * mcp-client.js 的测试：只测不依赖网络的纯逻辑部分。
 *
 * 真实的建连/调用在 live.test.js 里跑（需要本机或官方的 penpot MCP）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyFailure, errorText, withTimeout, withToken } from '../src/mcp-client.js'

test('withToken 把 userToken 拼进 URL（已有 query 时用 &）', () => {
  assert.equal(
    withToken('https://design.penpot.app/mcp/stream', 'k1'),
    'https://design.penpot.app/mcp/stream?userToken=k1',
  )
  assert.equal(
    withToken('https://x/mcp/stream?a=1', 'k1'),
    'https://x/mcp/stream?a=1&userToken=k1',
  )
})

test('withToken 幂等：已有同一个 token 不重复拼', () => {
  const once = withToken('https://x/mcp/stream', 'k1')
  assert.equal(withToken(once, 'k1'), once)
})

test('withToken 空 token 时原样返回', () => {
  assert.equal(withToken('https://x/mcp', ''), 'https://x/mcp')
})

test('classifyFailure 认得四种真实报错', () => {
  assert.equal(
    classifyFailure('Tool execution failed: Error: No userToken found in session context. Multi-user mode requires authentication.').stage,
    'no-token',
  )
  assert.equal(
    classifyFailure('Tool execution failed: Error: No Penpot instance connected for user token. Please ensure that Penpot is connected and that the MCP client connection is using the correct token.').stage,
    'no-instance',
  )
  assert.equal(
    classifyFailure('Tool execution failed: Error: No Penpot plugin instances are currently connected.').stage,
    'no-instance',
  )
  // 其他 Tool execution failed 归到端点级，不是「已打通」
  assert.equal(classifyFailure('Tool execution failed: Error: something else').stage, 'endpoint')
  assert.equal(classifyFailure('').stage, 'endpoint')
})

test('errorText 把 cause 链拼成一行', () => {
  const inner = new Error('ECONNREFUSED ::1:4401')
  const outer = new Error('fetch failed')
  outer.cause = inner
  const text = errorText(outer)
  assert.match(text, /fetch failed/)
  assert.match(text, /ECONNREFUSED/)
  assert.equal(text.includes('\n'), false)
})

test('withTimeout 超时后 reject，正常结束不 reject', async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 30, 'timeout!'), /timeout!/)
  const value = await withTimeout(Promise.resolve(42), 1000, 'timeout!')
  assert.equal(value, 42)
})

test('withTimeout 对非正超时直接透传', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 0, 'nope')
  assert.equal(value, 'ok')
})
