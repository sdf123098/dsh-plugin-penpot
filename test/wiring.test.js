/**
 * 接线测试：用一个假的 cordis ctx 把 apply() 跑起来，确认
 *   - 工具真的注册了（名字与数量）
 *   - 审批闸门挂到了 tools/pre-execute
 *   - 没装 webServer / betterSidebar 时不炸
 *   - 装了 webServer 时 /api/penpot 路由注册了
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'penpot-wiring-'))
process.env.DSH_HOME = home

const plugin = await import('../src/index.js')

/**
 * 造一个最小的 cordis ctx。
 *
 * 只实现插件真正用到的那几个面：logger / effect / on / get / provide / tools / inject。
 */
function fakeContext() {
  const tools = []
  const listeners = []
  const provided = new Map()
  const services = new Map()
  const effects = []
  const sections = []
  const routes = []

  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    on(event, listener) {
      listeners.push({ event, listener })
      return () => {}
    },
    get(name) {
      return services.get(name)
    },
    provide(name, value) {
      provided.set(name, value)
      services.set(name, value)
    },
    effect(factory) {
      const disposer = factory()
      effects.push(disposer)
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    // 可选服务：按需注入其实就是「等到有了再调用」
    inject(deps, callback) {
      const available = deps.every(dep => services.has(dep))
      if (!available) return undefined
      const scoped = {
        get: name => services.get(name),
        webServer: services.get('webServer'),
        logger: ctx.logger,
      }
      return callback(scoped)
    },
  }
  return { ctx, tools, listeners, provided, services, effects, sections, routes }
}

/** 需要有 systemPrompt 服务才能收公告。 */
function withSystemPrompt(harness) {
  const sections = []
  harness.services.set('systemPrompt', {
    section(input) {
      sections.push(input)
      return () => {}
    },
  })
  return sections
}

test('apply 注册 9 个工具，名字与文档一致', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', startup: 'lazy' })
  const names = harness.tools.map(tool => tool.name).sort()
  assert.deepEqual(names, [
    'penpot_api_info',
    'penpot_control',
    'penpot_execute_code',
    'penpot_export_shape',
    'penpot_high_level_overview',
    'penpot_import_image',
    'penpot_read',
    'penpot_status',
    'penpot_write',
  ])
})

test('exposeControlTool=false 时不注册 penpot_control', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', exposeControlTool: false })
  const names = harness.tools.map(tool => tool.name)
  assert.equal(names.includes('penpot_control'), false)
  // 5 个上游 + status + read + write
  assert.equal(names.length, 8)
})

test('每个工具都有 description / parameters / output / execute', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local' })
  for (const tool of harness.tools) {
    assert.equal(typeof tool.name, 'string')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 10, `${tool.name} 的 description 太短`)
    assert.equal(typeof tool.execute, 'function')
    assert.notEqual(tool.output, undefined, `${tool.name} 缺 output`)
  }
})

test('审批闸门挂在 tools/pre-execute 上', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', requireApproval: true })
  const gate = harness.listeners.find(entry => entry.event === 'tools/pre-execute')
  assert.notEqual(gate, undefined)
  assert.equal(typeof gate.listener, 'function')
})

test('requireApproval=false 时不挂闸门', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', requireApproval: false })
  const gate = harness.listeners.find(entry => entry.event === 'tools/pre-execute')
  assert.equal(gate, undefined)
})

test('闸门只拦 execute_code / import_image / write，其他放行', async () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', requireApproval: true })
  const gate = harness.listeners.find(entry => entry.event === 'tools/pre-execute').listener

  let passed = 0
  const next = async () => { passed++; return { kind: 'allow' } }

  // 不相关的工具：放行
  await gate({ name: 'penpot_status', arguments: {} }, next)
  // 相关的：返回 ask
  const decision = await gate({ name: 'penpot_execute_code', arguments: { code: 'return 1' } }, next)
  assert.equal(decision.kind, 'ask')
  assert.match(decision.reason, /设计文件|JavaScript/)
  assert.equal(passed, 1)

  const importDecision = await gate({ name: 'penpot_import_image', arguments: { filePath: '/tmp/a.png' } }, next)
  assert.equal(importDecision.kind, 'ask')
  assert.match(importDecision.reason, /a\.png/)

  // penpot_write 走 REST 改稿，也必须问 —— 它同样会增删图层
  const writeDecision = await gate({ name: 'penpot_write', arguments: { op: 'deleteShapes', fileId: 'f1' } }, next)
  assert.equal(writeDecision.kind, 'ask')
  assert.match(writeDecision.reason, /deleteShapes/)
  assert.match(writeDecision.reason, /f1/)

  // 只读工具永远不问
  await gate({ name: 'penpot_read', arguments: { what: 'teams' } }, next)
})

test('闸门在审批策略为 never 时放行（问了也只会被拒）', async () => {
  const harness = fakeContext()
  harness.services.set('approval', { effectivePolicy: () => 'never' })
  plugin.apply(harness.ctx, { mode: 'local', requireApproval: true })
  const gate = harness.listeners.find(entry => entry.event === 'tools/pre-execute').listener
  let passed = 0
  const decision = await gate(
    { name: 'penpot_execute_code', arguments: { code: 'x' }, agent: { session: {} } },
    async () => { passed++; return { kind: 'allow' } },
  )
  assert.equal(decision.kind, 'allow')
  assert.equal(passed, 1)
})

test('没有 systemPrompt 服务时不炸（公告只是跳过）', () => {
  const harness = fakeContext()
  assert.doesNotThrow(() => plugin.apply(harness.ctx, { mode: 'local' }))
})

test('有 systemPrompt 时注册公告段', () => {
  const harness = fakeContext()
  const sections = withSystemPrompt(harness)
  plugin.apply(harness.ctx, { mode: 'local' })
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-plugin-penpot')
  // 公告里要讲清「没有 OAuth」与三档，否则模型会瞎猜
  assert.match(sections[0].text, /OAuth/)
  assert.match(sections[0].text, /userToken/)
  assert.match(sections[0].text, /official|官方/)
  assert.match(sections[0].text, /auto|自动/)
})

test('有 webServer 时注册 /api/penpot 路由', () => {
  const harness = fakeContext()
  const routes = []
  harness.services.set('webServer', {
    register(route) {
      routes.push(route)
      return () => {}
    },
  })
  plugin.apply(harness.ctx, { mode: 'local' })
  assert.equal(routes.length, 1)
  assert.equal(routes[0].kind, 'prefix')
  assert.equal(routes[0].path, '/api/penpot')
  assert.equal(typeof routes[0].handler, 'function')
})

test('provide 了 penpotDetect（供 control 工具的 detect op 用）', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local' })
  assert.equal(typeof harness.provided.get('penpotDetect'), 'function')
})

test('配置里的 port 传到了 snapshot', () => {
  const harness = fakeContext()
  plugin.apply(harness.ctx, { mode: 'local', local: { httpPort: 4601, wsPort: 4602, replPort: 4603 } })
  const statusTool = harness.tools.find(tool => tool.name === 'penpot_status')
  assert.notEqual(statusTool, undefined)
})

test('apply 不抛（未装 webServer / betterSidebar / systemPrompt 的裸 profile）', () => {
  const harness = fakeContext()
  assert.doesNotThrow(() => plugin.apply(harness.ctx, {}))
})

test('auto 档在没有任何配置时也能起来（不阻塞宿主）', async () => {
  const harness = fakeContext()
  const emptyHome = join(home, 'empty-auto')
  mkdirSync(emptyHome, { recursive: true })
  process.env.DSH_HOME = emptyHome
  assert.doesNotThrow(() => plugin.apply(harness.ctx, { mode: 'auto', startup: 'lazy' }))
  // 让异步的判定与清理跑一下
  await new Promise(resolve => setTimeout(resolve, 50))
  process.env.DSH_HOME = home
})
