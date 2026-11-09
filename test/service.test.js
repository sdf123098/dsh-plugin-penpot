/**
 * service.js 的测试：状态机、探测分级、配置视图脱敏。
 *
 * 这里**不**起真实进程（那在 live.test.js 里），用注入的假 session 验证行为。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'penpot-service-'))

const { PenpotService, STAGES } = await import('../src/service.js')

/** 造一个假 session。 */
function fakeSession({ tools = ['execute_code'], callResult } = {}) {
  return {
    transportKind: 'http',
    endpoint: 'http://127.0.0.1:4401/mcp',
    closed: false,
    toolNames: () => tools,
    has: name => tools.includes(name),
    call: async () => callResult ?? { ok: true, text: '2', images: [], value: undefined },
    close: async () => { /* noop */ },
  }
}

test('初始状态是 idle，mode 按配置解析', () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'local' })
  const snapshot = service.snapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.mode, 'local')
  assert.equal(snapshot.hasSession, false)
})

test('publicConfig 不泄露 token，只给「配没配」', () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official', official: { endpoint: 'https://x/mcp/stream', token: 'SUPER-SECRET-KEY' } })
  const view = service.publicConfig()
  const serialized = JSON.stringify(view)
  assert.equal(serialized.includes('SUPER-SECRET-KEY'), false)
  assert.equal(view.official.auth.configured, true)
  assert.equal(view.official.auth.preview.endsWith('KEY'.slice(-4)) || view.official.auth.preview.startsWith('…'), true)
})

test('publicConfig：URL 里的 userToken 被拆走，回显的地址是干净的', () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'selfhost', selfhost: { url: 'https://p.example/mcp/stream?userToken=abc' } })
  const view = service.publicConfig()
  // 0.2.0 起 token 与地址分开存：地址回显时本来就不含 token（比打码更彻底，
  // 面板可以直接把它填进输入框而不担心覆盖凭据）
  assert.equal(view.selfhost.url.includes('abc'), false)
  assert.equal(view.selfhost.url.includes('userToken'), false)
  assert.equal(view.selfhost.auth.configured, true, 'token 拆出来单独存，仍然算「配了」')
  // 序列化后的整体也不该漏
  assert.equal(JSON.stringify(view).includes('abc'), false)
})

test('probe：没有 execute_code 时判为端点级可疑', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'local' })
  service.session = fakeSession({ tools: ['high_level_overview'] })
  service.tools = ['high_level_overview']
  service.state = 'running'
  const probe = await service.probe()
  assert.equal(probe.stage, 'endpoint')
  assert.match(probe.detail, /execute_code/)
})

test('probe：上游返回 no-instance 时判为「Penpot 未连上来」', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official' })
  service.session = fakeSession({
    callResult: {
      ok: false,
      text: 'Tool execution failed: Error: No Penpot instance connected for user token.',
      stage: 'no-instance',
      detail: 'key 已带，但 Penpot 那边没有连上来',
    },
  })
  service.tools = ['execute_code']
  service.state = 'running'
  const probe = await service.probe()
  assert.equal(probe.stage, 'no-instance')
  assert.equal(probe.label, STAGES['no-instance'])
  // 没配任何凭据 → REST 也不行 → 真出事了
  assert.equal(service.snapshot().state, 'degraded')
})

test('MCP 没打通但 REST（PAT）验通了 → 状态是 rest 而不是 degraded', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'a-real-key' },
    pat: { reuseMcpKey: true },
  })
  service.session = fakeSession({
    callResult: {
      ok: false,
      text: 'Tool execution failed: Error: No Penpot instance connected for user token.',
      stage: 'no-instance',
      detail: 'key 已带，但 Penpot 那边没有连上来',
    },
  })
  service.probePat = async () => {
    service.lastPatProbe = { at: new Date().toISOString(), stage: 'ok', label: '凭据有效', detail: '可以读到 1 个团队', from: 'mcp-key' }
    return service.lastPatProbe
  }
  service.tools = ['execute_code']
  service.state = 'running'
  await service.probe()

  // 关键：标签页没开，但 REST 能读写设计稿 —— 功能完好，不该报「已中断」
  assert.equal(service.snapshot().state, 'rest')
})

test('channels()：两条通道分开报，MCP 说需要标签页、REST 说不需要', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'k' },
    pat: { reuseMcpKey: true },
  })
  service.session = fakeSession({
    callResult: { ok: false, text: 'No Penpot instance connected', stage: 'no-instance', detail: '' },
  })
  service.tools = ['execute_code']
  service.state = 'running'
  service.probePat = async () => {
    service.lastPatProbe = { at: new Date().toISOString(), stage: 'ok', label: '凭据有效', detail: '', from: 'mcp-key' }
    return service.lastPatProbe
  }
  await service.probe()
  const channels = service.channels()
  assert.equal(channels.mcp.usable, false)
  assert.equal(channels.mcp.needsTab, true)
  assert.equal(channels.rest.usable, true)
  assert.equal(channels.rest.needsTab, false, 'REST 不需要标签页 —— 这条必须显式标出来')
})

test('autoCheck：不碰 MCP、不拉进程，只验 REST', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'k' },
    pat: { reuseMcpKey: true },
  })
  let called = 0
  service.probePat = async () => {
    called++
    service.lastPatProbe = { at: new Date().toISOString(), stage: 'ok', label: '凭据有效', detail: '', from: 'mcp-key' }
    return service.lastPatProbe
  }
  service.ensureReady = async () => { throw new Error('autoCheck 不该建 MCP 连接') }

  const result = await service.autoCheck()
  assert.equal(result.stage, 'ok')
  assert.equal(result.skipped, false)
  assert.equal(called, 1)
  // MCP 的 state 一动没动
  assert.equal(service.state, 'idle')
})

test('autoCheck：刚验过就复用结论，不重复打远端', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'k' },
    pat: { reuseMcpKey: true },
  })
  let called = 0
  service.probePat = async () => {
    called++
    service.lastPatProbe = { at: new Date().toISOString(), stage: 'ok', label: '凭据有效', detail: '', from: 'mcp-key' }
    return service.lastPatProbe
  }
  await service.autoCheck()
  const second = await service.autoCheck()
  assert.equal(second.skipped, true)
  assert.equal(called, 1, '60 秒内不该再打一次')
})

test('autoCheck：没配令牌时明确记成 no-token，不留旧结论', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official', official: { endpoint: 'https://design.penpot.app/mcp/stream', token: '' }, pat: { reuseMcpKey: false } })
  service.lastPatProbe = { at: new Date().toISOString(), stage: 'ok', detail: '旧结论', label: '凭据有效' }
  const result = await service.autoCheck({ force: true })
  assert.equal(result.stage, 'no-token')
  assert.equal(service.lastPatProbe.stage, 'no-token', '旧结论必须被覆盖，不能骗人')
})

test('probe：成功时判为已打通', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'local' })
  service.session = fakeSession()
  service.tools = ['execute_code']
  service.state = 'running'
  const probe = await service.probe()
  assert.equal(probe.stage, 'ok')
  assert.equal(probe.label, STAGES.ok)
})

test('callTool：连接没就绪时抛出可读错误', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official' })
  // 让 ensureReady 立即失败：用一个不可达的端点 + 极短超时
  service.config = { ...service.config, official: { ...service.config.official, endpoint: 'http://127.0.0.1:59998/mcp/stream', token: '' }, connectTimeoutMs: 800 }
  await assert.rejects(() => service.callTool('execute_code', { code: '1' }), /./)
})

test('callTool：上游没有该工具时明确说明，而不是静默失败', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official' })
  service.session = fakeSession({ tools: ['execute_code'] })
  service.tools = ['execute_code']
  service.state = 'running'
  await assert.rejects(
    () => service.callTool('import_image', { filePath: '/x.png' }),
    /没有 import_image/,
  )
})

test('callTool 更新 lastUsedAt（空闲停止依赖它）', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'local' })
  service.session = fakeSession()
  service.tools = ['execute_code']
  service.state = 'running'
  service.lastUsedAt = 1000
  await service.callTool('execute_code', { code: '1' })
  assert.ok(service.lastUsedAt > 1000)
})

test('disconnect 清空 session 与工具表，但不碰进程', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({ mode: 'official' })
  service.session = fakeSession()
  service.tools = ['execute_code']
  service.state = 'running'
  await service.disconnect()
  assert.equal(service.session, undefined)
  assert.deepEqual(service.tools, [])
  assert.equal(service.snapshot().state, 'idle')
})

test('locateFile：从 fileId 反查 team-id（openDesign 需要它，否则被踢回 dashboard）', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'k' },
    pat: { reuseMcpKey: true },
  })
  service.readPenpot = async (command, params) => {
    if (command === 'get-teams') return [{ id: 'team-a' }, { id: 'team-b' }]
    if (command === 'get-projects') {
      return params['team-id'] === 'team-b' ? [{ id: 'proj-1' }] : []
    }
    if (command === 'get-project-files') return [{ id: 'other' }, { id: 'wanted' }]
    if (command === 'get-file') return { data: { pages: ['page-1'] } }
    return []
  }

  const located = await service.locateFile('wanted')
  assert.deepEqual(located, { teamId: 'team-b', projectId: 'proj-1', pageId: 'page-1' })
})

test('locateFile：查不到就返回 undefined，不抛（不能挡住打开这件事）', async () => {
  const service = new PenpotService({ log: () => {} })
  service.refreshConfig({
    mode: 'official',
    official: { endpoint: 'https://design.penpot.app/mcp/stream', token: 'k' },
    pat: { reuseMcpKey: true },
  })
  service.readPenpot = async () => { throw new Error('boom') }
  assert.equal(await service.locateFile('nope'), undefined)
  assert.equal(await service.locateFile(''), undefined)
})
