/**
 * 个人访问令牌（PAT）只读通道的测试。
 *
 * 这里不联网：`rest.js` 把底层 HTTPS 请求收在一个函数里，测试通过改写
 * `globalThis.fetch` 之外的手段不现实，所以改用「起一个本地 http 服务器」来验
 * 真实的报文形状 —— 这比打桩更可靠，能同时验到认证头、参数名、超时、错误分级。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  ALLOWED_COMMANDS,
  apiBaseOf,
  callCommand,
  verifyToken,
} from '../src/rest.js'

/** 起一个临时 HTTP 服务，返回它的地址与收到的请求记录。 */
async function withServer(handler, fn) {
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      received.push({ method: req.method, url: req.url, headers: req.headers, body })
      handler(req, res, body)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    return await fn({ base: `http://127.0.0.1:${address.port}`, received })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('apiBaseOf 从 MCP 端点推出 REST 基址', () => {
  assert.equal(apiBaseOf('https://design.penpot.app/mcp/stream?userToken=x'), 'https://design.penpot.app')
  assert.equal(apiBaseOf('https://design.penpot.app/mcp/sse'), 'https://design.penpot.app')
  assert.equal(apiBaseOf('https://penpot.example.com/mcp/stream'), 'https://penpot.example.com')
  // 反代挂在子路径下：只砍掉 /mcp 及其之后，前缀要留着
  assert.equal(apiBaseOf('https://example.com/penpot/mcp/stream'), 'https://example.com/penpot')
  assert.equal(apiBaseOf(''), '')
  assert.equal(apiBaseOf('not a url'), '')
})

test('白名单只含只读命令', () => {
  const writes = ['create-file', 'update-file', 'delete-file', 'create-project', 'rename-file', 'update-profile']
  for (const command of writes) {
    assert.equal(ALLOWED_COMMANDS.includes(command), false, `${command} 是写命令，不该在只读白名单里`)
  }
  // 只读的那几个必须在
  for (const command of ['get-teams', 'get-projects', 'get-project-files', 'get-file-summary', 'get-page']) {
    assert.ok(ALLOWED_COMMANDS.includes(command), `${command} 应该可用`)
  }
})

test('不在任何白名单的命令被拒，且不发请求', async () => {
  await withServer((req, res) => res.end('{}'), async ({ base, received }) => {
    // update-profile / delete-team 这类既不在读名单、也不在写名单
    const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'x', command: 'delete-team' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-allowed')
    assert.equal(received.length, 0, '被拒的命令不该真的发出去')
  })
})

test('在白名单里的写命令，不给 allowWrite 也只是拒绝（不会真发）', async () => {
  await withServer((req, res) => res.end('{}'), async ({ base, received }) => {
    const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'x', command: 'update-file' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'write-requires-opt-in')
    assert.equal(received.length, 0)
  })
})

test('没有令牌时报 no-token，不发请求', async () => {
  await withServer((req, res) => res.end('{}'), async ({ base, received }) => {
    const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: '', command: 'get-teams' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'no-token')
    assert.equal(received.length, 0)
  })
})

test('请求形状：POST + Authorization: Token + kebab-case 参数', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 't1', name: 'Default' }]))
    },
    async ({ base, received }) => {
      const result = await callCommand({
        endpoint: `${base}/mcp/stream`,
        token: 'pat-abc',
        command: 'get-projects',
        params: { 'team-id': 't1' },
      })
      assert.equal(result.ok, true)
      assert.equal(received.length, 1)
      const request = received[0]
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/api/rpc/command/get-projects')
      // Penpot 只认 Token 前缀；Bearer 会 401（实测）
      assert.equal(request.headers.authorization, 'Token pat-abc')
      assert.equal(request.headers['content-type'], 'application/json')
      assert.deepEqual(JSON.parse(request.body), { 'team-id': 't1' })
      assert.deepEqual(result.data, [{ id: 't1', name: 'Default' }])
    },
  )
})

test('401 被分级成 bad-token（令牌无效，而不是端点不通）', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'authentication', code: 'authentication-required' }))
    },
    async ({ base }) => {
      const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'bad', command: 'get-teams' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'bad-token')
      const verified = await verifyToken({ endpoint: `${base}/mcp/stream`, token: 'bad' })
      assert.equal(verified.stage, 'bad-token')
    },
  )
})

test('Cloudflare 挑战页被单独识别成 blocked，不误报成令牌无效', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(403, { 'content-type': 'text/html' })
      res.end('<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>')
    },
    async ({ base }) => {
      const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'ok', command: 'get-teams' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'blocked', '网关拦截不该被当成凭据问题')
    },
  )
})

test('连不上时报 endpoint（不是令牌问题）', async () => {
  // 指向一个必然关着的端口
  const result = await callCommand({
    endpoint: 'http://127.0.0.1:1/mcp/stream',
    token: 'x',
    command: 'get-teams',
    timeoutMs: 2000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'endpoint')
})

test('verifyToken 成功时说清楚能读到几个团队', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify([{ id: 't1', name: 'Default' }, { id: 't2', name: 'Team B' }]))
    },
    async ({ base }) => {
      const verified = await verifyToken({ endpoint: `${base}/mcp/stream`, token: 'ok' })
      assert.equal(verified.stage, 'ok')
      assert.equal(verified.teamCount, 2)
      assert.match(verified.detail, /Default/)
    },
  )
})

test('返回非 JSON 时给出 bad-json（反代登录页的典型症状）', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>login</body></html>')
    },
    async ({ base }) => {
      const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'x', command: 'get-teams' })
      assert.equal(result.ok, false)
      assert.equal(result.code, 'bad-json')
    },
  )
})
