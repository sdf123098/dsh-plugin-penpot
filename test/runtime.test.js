/**
 * runtime.js 的纯逻辑测试（不起进程）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'penpot-runtime-'))

const runtime = await import('../src/runtime.js')

test('looksLikePenpot 只认 penpot 相关命令行', () => {
  assert.equal(runtime.looksLikePenpot('node C:\\x\\penpot\\packages\\server\\dist\\index.js'), true)
  assert.equal(runtime.looksLikePenpot('node .../packages/server/dist/index.js'), true)
  assert.equal(runtime.looksLikePenpot('node C:\\other\\app.js'), false)
  assert.equal(runtime.looksLikePenpot(''), false)
  assert.equal(runtime.looksLikePenpot(undefined), false)
})

test('parseSseOrJson 同时处理 SSE 与裸 JSON', () => {
  assert.deepEqual(runtime.parseSseOrJson('{"a":1}'), { a: 1 })
  assert.deepEqual(runtime.parseSseOrJson('event: message\ndata: {"b":2}\n'), { b: 2 })
  assert.equal(runtime.parseSseOrJson(''), undefined)
  assert.equal(runtime.parseSseOrJson('not json'), undefined)
})

test('resolveLocalLaunch：repo 子选项把 cwd 锁在 entry 所在目录（data/ 在那里）', () => {
  const config = {
    local: {
      sub: 'repo',
      repoDir: 'C:\\repo',
      entry: 'packages/server/dist/index.js',
      nodePath: '',
      npmTag: 'stable',
      host: '127.0.0.1',
      httpPort: 4401,
      wsPort: 4402,
      replPort: 4403,
      logLevel: 'info',
      env: {},
    },
  }
  const launch = runtime.resolveLocalLaunch(config)
  // 关键：cwd 必须是 entry 的目录 —— PenpotMcpServer 按 process.cwd() 找 data/，
  // 而 build 会把 data/ 拷进 dist/。
  assert.equal(launch.cwd, join('C:\\repo', 'packages', 'server', 'dist'))
  assert.equal(launch.args[0], join('C:\\repo', 'packages', 'server', 'dist', 'index.js'))
})

test('resolveLocalLaunch：npm 子选项用 npx 起官方包', () => {
  const config = { local: { sub: 'npm', npmTag: 'next', repoDir: '', entry: '', nodePath: '' } }
  const launch = runtime.resolveLocalLaunch(config)
  assert.match(launch.command, /npx/)
  assert.deepEqual(launch.args, ['-y', '@penpot/mcp@next'])
})

test('resolveLocalEnv 钉死 host 与三个端口', () => {
  const config = { local: { host: '127.0.0.1', httpPort: 4501, wsPort: 4502, replPort: 4503, logLevel: 'debug', env: { EXTRA: 'yes' } } }
  const env = runtime.resolveLocalEnv(config)
  assert.equal(env.PENPOT_MCP_SERVER_HOST, '127.0.0.1')
  assert.equal(env.PENPOT_MCP_SERVER_PORT, '4501')
  assert.equal(env.PENPOT_MCP_WEBSOCKET_PORT, '4502')
  assert.equal(env.PENPOT_MCP_REPL_PORT, '4503')
  assert.equal(env.PENPOT_MCP_LOG_LEVEL, 'debug')
  assert.equal(env.EXTRA, 'yes')
})

test('resolveNodePath：配置优先，其次当前 execPath', () => {
  assert.equal(runtime.resolveNodePath('D:/node/node.exe'), 'D:/node/node.exe')
  const fallback = runtime.resolveNodePath('')
  assert.equal(typeof fallback, 'string')
  assert.ok(fallback.length > 0)
})

test('probePort 对关闭的端口返回 false', async () => {
  assert.equal(await runtime.probePort('127.0.0.1', 59997, 200), false)
})

test('readLogTail 在没日志文件时返回空串', () => {
  assert.equal(runtime.readLogTail(10), '')
})

test('isProcessAlive：当前进程为 true，离谱 pid 为 false', () => {
  assert.equal(runtime.isProcessAlive(process.pid), true)
  assert.equal(runtime.isProcessAlive(999_999_999), false)
})

test('stopLocal 在没有运行记录时安全返回', async () => {
  const result = await runtime.stopLocal({ log: () => {} })
  assert.equal(result.ok, true)
  assert.equal(result.stopped, false)
})

test('verifyPenpotEndpoint 对关闭端口返回 ok:false 而不是抛', async () => {
  const result = await runtime.verifyPenpotEndpoint('127.0.0.1', 59996, 500)
  assert.equal(result.ok, false)
})
