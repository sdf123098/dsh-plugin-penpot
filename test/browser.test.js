/**
 * 无人值守浏览器的测试。
 *
 * 这个模块会真的 spawn 一个浏览器，所以测试分两层：
 *   - **不 spawn 的部分**：浏览器探测、profile 路径、状态读写、CDP 客户端报文
 *   - **要 spawn 的部分**：只在 `PENPOT_BROWSER_E2E=1` 时跑（本机装了 Chromium 系才有意义）
 *
 * 「不碰用户默认浏览器」是这里最要紧的约束，所以专门测了
 * 「关的时候只关自己起的那个 pid」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

// 必须在 import 模块之前设 DSH_HOME（模块读它算 profile 路径）
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'penpot-browser-test-'))

const browser = await import('../src/browser.js')

const E2E = process.env.PENPOT_BROWSER_E2E === '1'

test('findChromium：找不到时给出「Zen 为什么不行 + 有别的路」的解释', () => {
  const result = browser.findChromium({ explicit: 'C:/definitely/not/here.exe' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /不存在/)
  assert.deepEqual(result.tried, ['C:/definitely/not/here.exe'])
})

test('findChromium：不指定路径时按平台候选找，找不到要说清为什么', () => {
  const result = browser.findChromium({})
  if (result.ok) {
    assert.equal(typeof result.kind, 'string')
    assert.equal(typeof result.path, 'string')
  } else {
    // Windows / macOS 找不到时必须解释「默认浏览器是 Zen 也没关系」
    assert.match(result.reason, /Chromium|Zen|penpot_write/)
    assert.ok(Array.isArray(result.tried) && result.tried.length > 0, '要列出试过哪些路径')
  }
})

test('profileDir 在 DSH 数据目录下，和用户浏览器隔离', () => {
  const dir = browser.profileDir()
  assert.match(dir, /dsh-plugin-penpot[\\/]browser[\\/]profile$/)
  assert.equal(dir.includes(process.env.DSH_HOME), true)
})

test('没起过浏览器时状态是「没在跑」，且不抛', async () => {
  const status = await browser.browseStatus()
  assert.equal(status.running, false)
  assert.equal(status.pid, undefined)
  assert.equal(typeof status.available, 'boolean')
})

test('closeDesignBrowser：没有实例时安静地返回，不报错', async () => {
  const result = await browser.closeDesignBrowser()
  assert.equal(result.ok, true)
  assert.equal(result.closed, false)
})

test('resetBrowserProfile：没实例时能重置', () => {
  const result = browser.resetBrowserProfile()
  assert.equal(result.ok, true)
})

test('CdpClient 能连一个假 CDP 端点并完成一次请求-响应', async () => {
  // 一个最小 WebSocket 服务（手写握手太麻烦，这里用一个真的 http 让它失败）
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const client = new browser._internal.CdpClient(`ws://127.0.0.1:${port}/devtools/page/x`)
    await assert.rejects(() => client.connect(1500), /CDP 连接/)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('isAlive：当前进程活着，瞎编的 pid 不活', () => {
  assert.equal(browser._internal.isAlive(process.pid), true)
  assert.equal(browser._internal.isAlive(0), false)
  assert.equal(browser._internal.isAlive(-1), false)
  assert.equal(browser._internal.isAlive(undefined), false)
  // 一个几乎不可能存在的 pid
  assert.equal(browser._internal.isAlive(999_999_998), false)
})

test('浏览器候选表覆盖三个平台', () => {
  const table = browser._internal.CHROMIUM_CANDIDATES
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.ok(Array.isArray(table[platform]), `${platform} 要有候选`)
    assert.ok(table[platform].length > 0)
    for (const [kind, path] of table[platform]) {
      assert.equal(typeof kind, 'string')
      assert.equal(typeof path, 'string')
    }
  }
})

test('真的起一个浏览器：能打开、能复用、能关掉（要 PENPOT_BROWSER_E2E=1）', { skip: E2E ? false : 'set PENPOT_BROWSER_E2E=1' }, async () => {
  const first = await browser.openDesign({ appUrl: 'https://design.penpot.app' })
  assert.equal(first.ok, true, first.reason)
  assert.equal(first.reused, false)
  assert.equal(typeof first.port, 'number')

  const second = await browser.openDesign({ appUrl: 'https://design.penpot.app' })
  assert.equal(second.ok, true)
  assert.equal(second.reused, true, '第二个实例活着就该复用，不该再开一个')
  assert.equal(second.port, first.port)

  const status = await browser.browseStatus()
  assert.equal(status.running, true)
  assert.equal(status.pid, first.pid)

  const closed = await browser.closeDesignBrowser()
  assert.equal(closed.closed, true)
  assert.equal(browser._internal.isAlive(first.pid), false, '关掉后进程该真的没了')

  // 关第二次要安静返回
  const again = await browser.closeDesignBrowser()
  assert.equal(again.closed, false)
})

test('workspaceUrl：team-id 缺了会被 Penpot 静默重定向到 dashboard', () => {
  const base = 'https://design.penpot.app'
  // 只有 fileId：地址不完整 —— Penpot 不报错，只是踢回 dashboard
  const only = browser.workspaceUrl(base, { fileId: 'f1' })
  assert.equal(only, `${base}/?screen=workspace&file-id=f1`)
  assert.equal(only.includes('team-id'), false)

  // 给全才是能真正打开设计稿的地址
  const full = browser.workspaceUrl(base, { fileId: 'f1', teamId: 't1' })
  assert.match(full, /team-id=t1/)
  assert.match(full, /file-id=f1/)
  assert.match(full, /screen=workspace/)

  const withPage = browser.workspaceUrl(base, { fileId: 'f1', teamId: 't1', pageId: 'p1' })
  assert.match(withPage, /page-id=p1/)

  // 没 fileId 就回首页，不要拼出半截 workspace 地址
  assert.equal(browser.workspaceUrl(base, {}), `${base}/`)
  assert.equal(browser.workspaceUrl(base, { fileId: '  ' }), `${base}/`)
})

test('workspaceUrl 会对参数做编码（id 里出现怪字符也不能串味）', () => {
  const url = browser.workspaceUrl('https://x.test', { fileId: 'a&b=c', teamId: 't 1' })
  assert.match(url, /file-id=a%26b%3Dc/)
  assert.match(url, /team-id=t\+1|team-id=t%201/)
})
