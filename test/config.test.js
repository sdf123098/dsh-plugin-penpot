/**
 * 配置层的测试：三层合并、旧值迁移、端口/超时夹取。
 *
 * 这里最要紧的是 `pluginHosting` 的旧值迁移 —— 0.1.0 存的 `dsh` 在 0.2.0 里
 * 必须解释成 `bundled`，否则升级后用户会莫名其妙被要求自己起服务。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS, PLUGIN_HOSTING, mergeConfig, resolveConfig, resolveTarget } from '../src/config.js'

test('默认值：auto / lazy / bundled / 4400', () => {
  const config = resolveConfig({})
  assert.equal(config.mode, 'auto')
  assert.equal(config.startup, 'lazy')
  assert.equal(config.local.pluginHosting, 'bundled')
  assert.equal(config.local.pluginPort, 4400)
  assert.equal(config.pat.reuseMcpKey, true)
})

test('pluginHosting 的旧值 dsh 迁移成 bundled', () => {
  // 0.1.0 存的 'dsh' 当时其实没实现，落到「用户自备」分支。
  // 现在这一段真做出来了，旧值必须按 bundled 解释。
  assert.equal(resolveConfig({ local: { pluginHosting: 'dsh' } }).local.pluginHosting, 'bundled')
})

test('别的枚举不吃别名（别名表只给 pluginHosting 用）', () => {
  // transport 里 'dsh' 不是合法值 → 回落默认
  assert.equal(resolveConfig({ official: { transport: 'dsh' } }).official.transport, 'http')
  assert.equal(resolveConfig({ official: { transport: 'sse' } }).official.transport, 'sse')
})

test('pluginHosting 只接受三个值', () => {
  for (const value of PLUGIN_HOSTING) {
    assert.equal(resolveConfig({ local: { pluginHosting: value } }).local.pluginHosting, value)
  }
  assert.equal(resolveConfig({ local: { pluginHosting: 'zzz' } }).local.pluginHosting, 'bundled')
})

test('端口越界回落默认，字符串数字能认', () => {
  assert.equal(resolveConfig({ local: { httpPort: '4500' } }).local.httpPort, 4500)
  assert.equal(resolveConfig({ local: { httpPort: 99999 } }).local.httpPort, DEFAULTS.local.httpPort)
  assert.equal(resolveConfig({ local: { pluginPort: 0 } }).local.pluginPort, 4400)
})

test('超时夹取在合理区间', () => {
  const tiny = resolveConfig({ toolCallTimeoutMs: 1 })
  assert.ok(tiny.toolCallTimeoutMs >= 5_000, `太小了：${tiny.toolCallTimeoutMs}`)
  const huge = resolveConfig({ connectTimeoutMs: 99_999_999 })
  assert.ok(huge.connectTimeoutMs <= 600_000, `太大了：${huge.connectTimeoutMs}`)
})

test('三层合并：深层只覆盖给定的键', () => {
  const merged = mergeConfig(
    DEFAULTS,
    { local: { repoDir: 'D:/deploy' } },
    { local: { httpPort: 4600 } },
  )
  const config = resolveConfig(merged)
  assert.equal(config.local.httpPort, 4600, '用户覆盖生效')
  assert.equal(config.local.repoDir, 'D:/deploy', '部署值没被抹掉')
  assert.equal(config.local.wsPort, DEFAULTS.local.wsPort, '没指定的保持默认')
})

test('resolveTarget：auto 用 detected，local 推 http 端点', () => {
  const local = resolveTarget(resolveConfig({ mode: 'auto', detected: { picked: 'local' } }))
  assert.equal(local.kind, 'local')
  assert.equal(local.url, 'http://127.0.0.1:4401/mcp')

  const official = resolveTarget(resolveConfig({ mode: 'official' }))
  assert.equal(official.kind, 'official')
  assert.equal(official.url, DEFAULTS.official.endpoint)
})

test('resolveTarget：auto 没判定过时回落 local', () => {
  // 判定还没跑（首启、或扫描失败）时的安全选择：本地档最容易自己排查
  const target = resolveTarget(resolveConfig({ mode: 'auto', detected: { picked: '' } }))
  assert.equal(target.kind, 'local')
})
