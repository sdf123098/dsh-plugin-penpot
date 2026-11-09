/**
 * 插件 UI 静态托管的测试。
 *
 * 这个模块的安全边界最要紧：它在 `127.0.0.1` 上发文件，路径来自 HTTP 请求。
 * 所以这里重点测**拒绝**：`..`、URL 编码的 `..`、绝对路径、符号链接逃逸、
 * 不可执行的 MIME。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolvePluginDir, safeWithin, startPluginHost, DEFAULT_PLUGIN_DIR } from '../src/plugin-host.js'

/** 造一个像样的 dist 目录。 */
function makeDist() {
  const root = mkdtempSync(join(tmpdir(), 'penpot-dist-'))
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ name: 'Penpot MCP Plugin', code: 'plugin.js' }))
  writeFileSync(join(root, 'plugin.js'), 'console.log(1)')
  writeFileSync(join(root, 'index.html'), '<html></html>')
  mkdirSync(join(root, 'assets'))
  writeFileSync(join(root, 'assets', 'a.css'), 'body{}')
  return root
}

test('resolvePluginDir 找到 dist 与 manifest', () => {
  // 造一个符合上游布局的目录：<repo>/packages/plugin/dist
  const repo = mkdtempSync(join(tmpdir(), 'penpot-repo-'))
  const dist = join(repo, 'packages', 'plugin', 'dist')
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'manifest.json'), '{}')
  writeFileSync(join(dist, 'plugin.js'), '')
  try {
    const found = resolvePluginDir({ repoDir: repo })
    assert.equal(found.ok, true)
    assert.equal(found.dir, dist)
    assert.equal(found.manifest, join(dist, 'manifest.json'))
    // 指定别的相对路径也能用
    const custom = resolvePluginDir({ repoDir: repo, pluginDir: 'packages/plugin/dist' })
    assert.equal(custom.ok, true)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('resolvePluginDir 对缺目录 / 缺 manifest 给出可动手的理由', () => {
  const missing = resolvePluginDir({ repoDir: join(tmpdir(), 'definitely-not-here-12345') })
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不存在/)

  const root = mkdtempSync(join(tmpdir(), 'penpot-nodist-'))
  try {
    mkdirSync(join(root, 'packages', 'plugin', 'dist'), { recursive: true })
    const noManifest = resolvePluginDir({ repoDir: root })
    assert.equal(noManifest.ok, false)
    assert.match(noManifest.reason, /manifest\.json/)
    assert.match(noManifest.reason, /pnpm build/, '要告诉用户怎么修')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('safeWithin 允许正常文件，拒绝一切逃逸', () => {
  const root = makeDist()
  try {
    assert.notEqual(safeWithin(root, '/manifest.json'), undefined)
    assert.notEqual(safeWithin(root, '/assets/a.css'), undefined)
    assert.notEqual(safeWithin(root, '/'), undefined, '根路径要回落到 index.html')

    assert.equal(safeWithin(root, '/../../etc/passwd'), undefined)
    assert.equal(safeWithin(root, '/..%2f..%2fetc%2fpasswd'), undefined)
    assert.equal(safeWithin(root, '/%2e%2e/%2e%2e/secret'), undefined)
    assert.equal(safeWithin(root, '/manifest.json%00.png'), undefined, '空字节要拒')
    assert.equal(safeWithin(root, '/%zz'), undefined, '非法转义要拒')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('safeWithin 拒绝符号链接/联接点逃逸', () => {
  const root = makeDist()
  const outside = mkdtempSync(join(tmpdir(), 'penpot-outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'secret')
  try {
    if (process.platform === 'win32') {
      // Windows 建 symlink 要管理员权限，但目录联接（junction）不用 —— 它同样能逃逸
      execFileSync('cmd', ['/c', 'mklink', '/J', join(root, 'jump'), outside], { stdio: 'ignore' })
      assert.equal(safeWithin(root, '/jump/secret.txt'), undefined, '联接点指到外面要拒')
    } else {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
      assert.equal(safeWithin(root, '/link.txt'), undefined, '符号链接指到外面要拒')
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('静态服务真的发文件，且带 Penpot 需要的 CORS 头', async () => {
  const root = makeDist()
  const started = await startPluginHost({ dir: root, port: 0 })
  try {
    assert.equal(started.ok, true, started.reason)
    const manifest = await fetch(started.url)
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type') ?? '', /application\/json/)
    // Penpot 页面在别的域下：没有这个头，浏览器直接拦掉
    assert.equal(manifest.headers.get('access-control-allow-origin'), '*')
    assert.equal(manifest.headers.get('cache-control'), 'no-cache')
    const parsed = await manifest.json()
    assert.equal(parsed.name, 'Penpot MCP Plugin')

    const js = await fetch(`http://127.0.0.1:${started.port}/plugin.js`)
    assert.equal(js.status, 200)
    assert.match(js.headers.get('content-type') ?? '', /javascript/)
  } finally {
    await started.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态服务不给不认识的文件类型（挡住顺手放进去的可执行文件）', async () => {
  const root = makeDist()
  writeFileSync(join(root, 'evil.exe'), 'MZ')
  const started = await startPluginHost({ dir: root, port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${started.port}/evil.exe`)
    assert.equal(res.status, 415)
  } finally {
    await started.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态服务拒绝路径穿越（403，不是 404 —— 要说清是被拒不是没有）', async () => {
  const root = makeDist()
  const started = await startPluginHost({ dir: root, port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${started.port}/../../package.json`)
    assert.equal(res.status, 403)
  } finally {
    await started.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('静态服务只接受 GET/HEAD', async () => {
  const root = makeDist()
  const started = await startPluginHost({ dir: root, port: 0 })
  try {
    const res = await fetch(`http://127.0.0.1:${started.port}/manifest.json`, { method: 'POST' })
    assert.equal(res.status, 405)
  } finally {
    await started.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('端口上已经有一个同样的插件 UI → 接管，不报错也不去关别人', async () => {
  const root = makeDist()
  const first = await startPluginHost({ dir: root, port: 0 })
  try {
    const second = await startPluginHost({ dir: root, port: first.port })
    assert.equal(second.ok, true, second.reason)
    assert.equal(second.adopted, true)
    assert.equal(second.port, first.port)
    // 接管方不该去关别人的服务
    await second.close?.()
    const still = await fetch(first.url)
    assert.equal(still.status, 200, '接管后 close 不该把别人的服务关掉')
  } finally {
    await first.close?.()
    rmSync(root, { recursive: true, force: true })
  }
})

test('端口被别的服务占着时报错，并说清不是 Penpot 插件', async () => {
  const root = makeDist()
  // 用一个发别的东西的服务器占端口
  const foreign = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ name: 'Some Other App', version: '1.0.0' }))
  })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const port = foreign.address().port
  try {
    const blocked = await startPluginHost({ dir: root, port })
    assert.equal(blocked.ok, false)
    assert.match(blocked.reason, /占用|占着/)
    assert.match(blocked.reason, /Some Other App/, '要说清占端口的是谁')
  } finally {
    await new Promise((resolve) => foreign.close(resolve))
    rmSync(root, { recursive: true, force: true })
  }
})

test('DEFAULT_PLUGIN_DIR 指向上游的产物位置', () => {
  assert.equal(DEFAULT_PLUGIN_DIR, 'packages/plugin/dist')
})
