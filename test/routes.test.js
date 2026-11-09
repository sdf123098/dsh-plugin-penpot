/**
 * routes.js 的测试：信任栅栏、CSRF 头、各路由的分派。
 *
 * 用假的 req/res 对象直接调 handler，不起真的 HTTP 服务。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'penpot-routes-'))

const { WRITE_HEADER, hostTrustFence, isLoopbackRequest, makeRoute } = await import('../src/routes.js')
const { PenpotService } = await import('../src/service.js')

/** 造一个假的 req：只有 handler 会读的字段。 */
function fakeRequest({ method = 'GET', path = '/api/penpot/status', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: path,
    headers: { host: '127.0.0.1:56111', ...headers },
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个假的 res：收集状态码与 JSON。 */
function fakeResponse() {
  const out = { status: 0, headers: {}, body: undefined }
  const res = {
    writeHead(status, headers) {
      out.status = status
      out.headers = headers ?? {}
    },
    end(payload) {
      try { out.body = JSON.parse(String(payload ?? '')) } catch { out.body = String(payload) }
    },
  }
  return { res, out }
}

function makeTestRoute({ service = new PenpotService({ log: () => {} }), hooks = {} } = {}) {
  service.refreshConfig({ mode: 'local' })
  const merged = {
    detect: async () => ({ picked: 'local', from: 'test', rationale: 'test rationale', candidates: [] }),
    applyDetected: async () => ({ detected: {} }),
    migrateScan: () => ({ candidates: [], errors: [], scanned: [] }),
    migrateApply: async entries => ({ ok: true, applied: entries, configPatch: {} }),
    migrateRestore: async () => ({ ok: true }),
    migrateBackups: () => [],
    pluginManifest: () => ({ needed: false, reason: 'test' }),
    saveConfig: async patch => ({ config: service.publicConfig(), overrides: patch }),
    ...hooks,
  }
  return { route: makeRoute({ service, readConnection: () => undefined, log: () => {}, hooks: merged }), service }
}

async function call(route, req) {
  const { res, out } = fakeResponse()
  await route.handler(req, res)
  return out
}

test('栅栏：非回环地址被 403', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({ remoteAddress: '10.0.0.9' }))
  assert.equal(out.status, 403)
  assert.equal(out.body.ok, false)
})

test('栅栏：回环但 Host 不是本地名也被 403', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({ headers: { host: 'evil.example.com' } }))
  assert.equal(out.status, 403)
})

test('栅栏：cross-site 请求被 403', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({ headers: { 'sec-fetch-site': 'cross-site' } }))
  assert.equal(out.status, 403)
})

test('栅栏：给定 Connection 服务时用它的判定', () => {
  const reject = () => 401
  const allow = () => undefined
  assert.equal(hostTrustFence(() => ({ requestRejection: reject }))({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), 401)
  assert.equal(hostTrustFence(() => ({ requestRejection: allow }))({}), undefined)
})

test('isLoopbackRequest 认 127.0.0.1 / ::1 / localhost', () => {
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::1' }, headers: { host: 'localhost:1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { host: '127.0.0.1:1' } }), true)
  assert.equal(isLoopbackRequest({ socket: { remoteAddress: '192.168.1.2' }, headers: { host: '127.0.0.1:1' } }), false)
})

test('GET status 返回状态与脱敏配置', async () => {
  const { route, service } = makeTestRoute()
  service.refreshConfig({ mode: 'official', official: { token: 'SECRET' } })
  const out = await call(route, fakeRequest())
  assert.equal(out.status, 200)
  assert.equal(out.body.ok, true)
  assert.equal(JSON.stringify(out.body).includes('SECRET'), false)
  assert.equal(out.body.result.config.official.auth.configured, true)
})

test('GET ping 与 config', async () => {
  const { route } = makeTestRoute()
  const ping = await call(route, fakeRequest({ path: '/api/penpot/ping' }))
  assert.equal(ping.body.ok, true)
  const config = await call(route, fakeRequest({ path: '/api/penpot/config' }))
  assert.equal(config.body.result.mode, 'local')
})

test('写请求缺 CSRF 头 → 403', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({ method: 'POST', path: '/api/penpot/service', body: { op: 'start' } }))
  assert.equal(out.status, 403)
  assert.equal(out.body.error.code, 'csrf')
})

test('带 CSRF 头的 config.set 调 hooks.saveConfig', async () => {
  let received
  const { route } = makeTestRoute({
    hooks: { saveConfig: async patch => { received = patch; return { ok: true } } },
  })
  const out = await call(route, fakeRequest({
    method: 'POST',
    path: '/api/penpot/config.set',
    headers: { [WRITE_HEADER]: '1' },
    body: { patch: { mode: 'official' } },
  }))
  assert.equal(out.status, 200)
  assert.deepEqual(received, { mode: 'official' })
})

test('config.set 的 patch 非对象 → 400', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({
    method: 'POST',
    path: '/api/penpot/config.set',
    headers: { [WRITE_HEADER]: '1' },
    body: { patch: 'nope' },
  }))
  assert.equal(out.status, 400)
})

test('未知的 service op → 400', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({
    method: 'POST',
    path: '/api/penpot/service',
    headers: { [WRITE_HEADER]: '1' },
    body: { op: 'explode' },
  }))
  assert.equal(out.status, 400)
})

test('未知方法 → 404', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({
    method: 'POST',
    path: '/api/penpot/nope',
    headers: { [WRITE_HEADER]: '1' },
    body: {},
  }))
  assert.equal(out.status, 404)
})

test('GET 到写方法 → 405', async () => {
  const { route } = makeTestRoute()
  const out = await call(route, fakeRequest({ method: 'PUT', path: '/api/penpot/config.set' }))
  assert.equal(out.status, 405)
})

test('detect / migrate.scan / migrate.apply 走 hooks', async () => {
  let applied
  const { route } = makeTestRoute({
    hooks: { migrateApply: async entries => { applied = entries; return { ok: true, applied: entries } } },
  })
  const detect = await call(route, fakeRequest({ method: 'POST', path: '/api/penpot/detect', headers: { [WRITE_HEADER]: '1' }, body: {} }))
  assert.equal(detect.body.result.picked, 'local')

  const scan = await call(route, fakeRequest({ method: 'POST', path: '/api/penpot/migrate.scan', headers: { [WRITE_HEADER]: '1' }, body: {} }))
  assert.deepEqual(scan.body.result.candidates, [])

  const appliedOut = await call(route, fakeRequest({
    method: 'POST',
    path: '/api/penpot/migrate.apply',
    headers: { [WRITE_HEADER]: '1' },
    body: { entries: [{ name: 'x', action: 'import-only' }] },
  }))
  assert.equal(appliedOut.body.ok, true)
  assert.equal(applied.length, 1)
})

test('handler 抛错时回 500 而不是崩', async () => {
  const { route } = makeTestRoute({ hooks: { detect: async () => { throw new Error('boom') } } })
  const out = await call(route, fakeRequest({ method: 'POST', path: '/api/penpot/detect', headers: { [WRITE_HEADER]: '1' }, body: {} }))
  assert.equal(out.status, 500)
  assert.match(out.body.error.message, /boom/)
})
