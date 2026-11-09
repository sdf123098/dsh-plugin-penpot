/**
 * 真实联调：需要本机有可用的 penpot 构建，或能访问官方端点。
 *
 * 这些测试默认**跳过**（`PENPOT_LIVE=1` 才跑），因为：
 *   - 会真的 spawn 一个本地进程（约 3 秒）
 *   - 会真的发请求到 design.penpot.app
 * CI 与日常 `npm test` 不该依赖外部网络。
 *
 * 跑法：
 *   $env:PENPOT_LIVE='1'; node --test test/live.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const LIVE = process.env.PENPOT_LIVE === '1'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'penpot-live-'))

const { PenpotService } = await import('../src/service.js')
const { decideAuto } = await import('../src/detect.js')

/** 备用端口，避开用户可能正在跑的 4401。 */
const PORT = Number(process.env.PENPOT_LIVE_PORT ?? 4521)

test('官方端点：建连拿到 4 个工具，无 token 时探测停在「缺 MCP key」', { skip: LIVE ? false : 'set PENPOT_LIVE=1' }, async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    startup: 'lazy',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: '' },
  })
  const ready = await service.ensureReady()
  assert.equal(ready.ok, true, `建连失败：${ready.error}`)
  assert.deepEqual(
    [...ready.tools].sort(),
    ['execute_code', 'export_shape', 'high_level_overview', 'penpot_api_info'],
  )
  const probe = await service.probe()
  // 没有 token → 服务端报 "No userToken found in session context"
  assert.equal(probe.stage, 'no-token')
  await service.disconnect()
})

test('本地档：spawn → 5 个工具 → 探测 → 停止', { skip: LIVE ? false : 'set PENPOT_LIVE=1' }, async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'local',
    startup: 'lazy',
    connectTimeoutMs: 90_000,
    local: {
      sub: 'repo',
      repoDir: process.env.PENPOT_LIVE_REPO ?? join(homedir(), '.dsh', 'mcp-servers', 'penpot'),
      entry: 'packages/server/dist/index.js',
      host: '127.0.0.1',
      httpPort: PORT,
      wsPort: PORT + 1,
      replPort: PORT + 2,
    },
  })
  const ready = await service.ensureReady()
  assert.equal(ready.ok, true, `启动失败：${ready.error}`)
  assert.deepEqual(
    [...ready.tools].sort(),
    ['execute_code', 'export_shape', 'high_level_overview', 'import_image', 'penpot_api_info'],
  )
  const probe = await service.probe()
  // 没有 Penpot 浏览器会话连通时，必然停在「插件没连上来」
  assert.equal(probe.stage, 'no-instance')

  const stop = await service.stop()
  assert.equal(stop.ok, true)
  assert.equal(service.snapshot().state, 'idle')
})

test('自动判定在本机跑出结论（不要求可达）', { skip: LIVE ? false : 'set PENPOT_LIVE=1' }, async () => {
  const result = await decideAuto({ cwd: process.cwd(), probeTimeoutMs: 1200 })
  assert.ok(['official', 'local', 'selfhost'].includes(result.picked))
  assert.equal(typeof result.rationale, 'string')
  assert.ok(result.rationale.length > 0)
})

test('PAT 通道：无效令牌被判成 bad-token（MCP 通道做不到这件事）', { skip: LIVE ? false : 'set PENPOT_LIVE=1' }, async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: '' },
    pat: { token: 'definitely-not-a-real-token', reuseMcpKey: false },
  })
  const result = await service.probePat()
  // 服务端会 401；除非被 Cloudflare 挡了（那也算「没打通」，但原因不同）
  assert.ok(['bad-token', 'blocked'].includes(result.stage), `意外结果：${result.stage} —— ${result.detail}`)
})

test('PAT 通道：借真实 MCP key 能读到团队（需要 PENPOT_LIVE_TOKEN）', { skip: LIVE && process.env.PENPOT_LIVE_TOKEN ? false : 'set PENPOT_LIVE=1 与 PENPOT_LIVE_TOKEN' }, async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: process.env.PENPOT_LIVE_TOKEN },
    pat: { token: '', reuseMcpKey: true },
  })
  const verified = await service.probePat()
  assert.equal(verified.stage, 'ok', verified.detail)
  assert.equal(verified.from, 'mcp-key')
  const teams = await service.readPenpot('get-teams')
  assert.ok(Array.isArray(teams) && teams.length > 0)
  assert.equal(typeof teams[0].id, 'string')
})

test('PAT 白名单拒绝写命令', { skip: LIVE ? false : 'set PENPOT_LIVE=1' }, async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'x' },
    pat: { token: 'x', reuseMcpKey: false },
  })
  await assert.rejects(() => service.readPenpot('update-file', {}), /not-allowed/)
})
