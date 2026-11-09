/**
 * 凭据别名的测试：token 与 URL 分开存。
 *
 * 背景（同一个 bug 发生了两次）：token 原来只活在端点 URL 里
 * （`…?userToken=xxx`），而面板上的端点输入框必须脱敏 —— 两者直接打架：
 * 输入框显示去掉 token 的地址，用户一点保存就把带 token 的地址覆盖成
 * 不带 token 的，key 当场消失。
 *
 * 第一版护栏只拦 `userToken=***`，拦不住「被摘干净之后提交上来的干净 URL」。
 * 根治办法是**不让它处于二选一的形态**：URL 只存地址，token 单独存。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveConfig, splitUserToken, resolveTarget } from '../src/config.js'
import { keepCredentials, guardPatch } from '../src/store.js'

const REAL_KEY = 'eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0.real-key-value.String.here'
const ENDPOINT = 'https://design.penpot.app/mcp/stream'

test('splitUserToken：老形态（token 在 URL 里）会拆出来', () => {
  const split = splitUserToken(`${ENDPOINT}?userToken=${REAL_KEY}`, '')
  assert.equal(split.url, ENDPOINT)
  assert.equal(split.token, REAL_KEY)
})

test('splitUserToken：新形态（已经分开）原样返回', () => {
  const split = splitUserToken(ENDPOINT, REAL_KEY)
  assert.equal(split.url, ENDPOINT)
  assert.equal(split.token, REAL_KEY)
})

test('splitUserToken：两者都有时，显式 .token 赢', () => {
  const split = splitUserToken(`${ENDPOINT}?userToken=OLD`, 'NEW')
  assert.equal(split.url, ENDPOINT)
  assert.equal(split.token, 'NEW', '单独存的 token 是更新的来源')
})

test('splitUserToken：保留其他查询参数', () => {
  const split = splitUserToken(`${ENDPOINT}?a=1&userToken=K&b=2`, '')
  assert.equal(split.token, 'K')
  assert.match(split.url, /a=1/)
  assert.match(split.url, /b=2/)
  assert.equal(split.url.includes('userToken'), false)
})

test('splitUserToken：空值与畸形输入不炸', () => {
  assert.deepEqual(splitUserToken('', ''), { url: '', token: '' })
  assert.deepEqual(splitUserToken('not a url', 'K'), { url: 'not a url', token: 'K' })
  assert.equal(splitUserToken('not a url?userToken=K', '').token, 'K', '非 URL 也要能拆')
})

test('resolveConfig 把 official 拆成「干净地址 + 独立 token」', () => {
  const config = resolveConfig({ official: { endpoint: `${ENDPOINT}?userToken=${REAL_KEY}` } })
  assert.equal(config.official.endpoint, ENDPOINT, '配置里的地址永远不带 token')
  assert.equal(config.official.token, REAL_KEY)
})

test('resolveTarget 连接时会把 token 拼回去', () => {
  const config = resolveConfig({ mode: 'official', official: { endpoint: `${ENDPOINT}?userToken=${REAL_KEY}` } })
  const target = resolveTarget(config)
  assert.equal(target.kind, 'official')
  assert.equal(target.token, REAL_KEY, 'token 必须留给连接层')
  assert.equal(target.url, ENDPOINT)
})

test('keepCredentials：面板没提交 token 时，沿用磁盘上的', () => {
  const current = { official: { endpoint: ENDPOINT, token: REAL_KEY } }
  const patch = { mode: 'official', official: { endpoint: ENDPOINT } }
  const { patch: merged, kept } = keepCredentials(patch, current)
  assert.equal(merged.official.token, REAL_KEY, '不能因为面板没带 token 就把凭据弄丢')
  assert.deepEqual(kept, ['official.token'])
})

test('keepCredentials：磁盘上还是老形态（token 在 URL 里）也能补', () => {
  const current = { official: { endpoint: `${ENDPOINT}?userToken=${REAL_KEY}` } }
  const patch = { official: { endpoint: ENDPOINT } }
  const { patch: merged } = keepCredentials(patch, current)
  assert.equal(merged.official.token, REAL_KEY)
})

test('keepCredentials：显式传空串 = 用户要清空，尊重他', () => {
  const current = { official: { endpoint: ENDPOINT, token: REAL_KEY } }
  const patch = { official: { endpoint: ENDPOINT, token: '' } }
  const { patch: merged, kept } = keepCredentials(patch, current)
  assert.equal(merged.official.token, '')
  assert.deepEqual(kept, [])
})

test('keepCredentials：用户粘了带新 key 的地址 → 让新的赢', () => {
  const current = { official: { endpoint: ENDPOINT, token: REAL_KEY } }
  const patch = { official: { endpoint: `${ENDPOINT}?userToken=BRAND-NEW` } }
  const { patch: merged, kept } = keepCredentials(patch, current)
  assert.equal(merged.official.token, undefined, '不该把旧 key 塞回去跟新地址打架')
  assert.deepEqual(kept, [])
})

test('keepCredentials：自部署档同样适用', () => {
  const current = { selfhost: { url: 'https://p.example/mcp/stream', token: 'SH-KEY' } }
  const patch = { selfhost: { url: 'https://p.example/mcp/stream', allowInsecureTLS: true } }
  const { patch: merged } = keepCredentials(patch, current)
  assert.equal(merged.selfhost.token, 'SH-KEY')
  assert.equal(merged.selfhost.allowInsecureTLS, true, '别的字段照常更新')
})

test('keepCredentials：没有旧凭据时不凭空造一个', () => {
  const { patch: merged, kept } = keepCredentials({ official: { endpoint: ENDPOINT } }, {})
  assert.equal(merged.official.token, undefined)
  assert.deepEqual(kept, [])
})

test('两道护栏配合：占位符被摘、真凭据被补回', () => {
  const current = { official: { endpoint: ENDPOINT, token: REAL_KEY } }
  // 面板真的把占位符提交上来（旧版本的行为）
  const guarded = guardPatch({ official: { endpoint: `${ENDPOINT}?userToken=***` } })
  assert.deepEqual(guarded.dropped, ['official.endpoint'], '带 *** 的字段整条摘掉')
  const { patch: merged } = keepCredentials(guarded.patch, current)
  assert.equal(merged.official, undefined, '整块都没了 → 回落上一层，磁盘上的值原样保留')
})
