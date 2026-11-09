/**
 * 本地档的插件 UI 静态托管。
 *
 * ## 为什么需要它
 *
 * Penpot 的 MCP 连接是**两段**的：
 *
 *   1. 浏览器里的 Penpot 标签页加载一个插件 UI（`manifest.json` + `plugin.js`）
 *   2. 那个插件去连本机的 MCP 服务器（WebSocket，默认 4402）
 *
 * 第 2 段由 MCP 服务器负责；**第 1 段需要有人把 `packages/plugin/dist` 用 HTTP 发出去**，
 * 而且必须是带 `Access-Control-Allow-Origin` 的 HTTP —— Penpot 页面在
 * `design.penpot.app` 域下，`file://` 加载不了，跨域也不行。
 *
 * 上游的做法是 `pnpm run bootstrap` 起 vite preview。但那要用户先装依赖、记端口、
 * 手动起服务，而且它和 MCP 服务器是两条命。这里把这件事收进插件：本地档起来时
 * 顺手把这个静态服务拉起，停的时候一起停，端口与 `local.httpPort` 同一套配置。
 *
 * ## 安全边界
 *
 * - **只服务 `dist` 目录内**的文件：路径穿越（`../`、绝对路径、符号链接逃逸）一律拒绝。
 * - 只绑定 `local.host`（默认 `127.0.0.1`）：不对外网暴露。
 * - 只放 MIME 白名单里的类型：这里只该有 html/js/css/json/图片。
 * - `no-cache`：改了 dist 立刻生效，不用去 Penpot 里删插件重装。
 * - `Access-Control-Allow-Origin: *` 是**必须的**：Penpot 页面在另一个域下。
 *   这个服务只发本机 dist 里的静态文件、不接受任何写请求，所以放宽 CORS 没有风险。
 *
 * @module dsh-plugin-penpot/plugin-host
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, sep, extname, dirname } from 'node:path'

/** 允许发出的扩展名 → Content-Type。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** dist 目录在该仓库里的相对位置。 */
export const DEFAULT_PLUGIN_DIR = 'packages/plugin/dist'

/**
 * 定位插件 UI 产物目录。
 *
 * @param {object} options
 * @param {string} options.repoDir 本地仓库根
 * @param {string} [options.pluginDir] 相对 repoDir 的路径
 * @returns {{ ok: true, dir: string, manifest: string } | { ok: false, reason: string }}
 */
export function resolvePluginDir(options) {
  const { repoDir, pluginDir } = options
  if (typeof repoDir !== 'string' || repoDir === '') {
    return { ok: false, reason: '没有配置本地仓库目录' }
  }
  // 空串按默认相对路径处理（配置里留空=用上游的约定位置）
  const relative = typeof pluginDir === 'string' && pluginDir.trim() !== '' ? pluginDir.trim() : DEFAULT_PLUGIN_DIR
  const dir = resolve(repoDir, relative)
  const manifest = join(dir, 'manifest.json')
  if (!existsSync(dir)) {
    return { ok: false, reason: `插件 UI 产物不存在：${dir}（先 cd packages/plugin 跑一次 pnpm build）` }
  }
  if (!existsSync(manifest)) {
    // 有目录没 manifest：最常见的是只 build 了 server 没 build plugin
    return { ok: false, reason: `${dir} 存在但没有 manifest.json —— 只构建了 server？在 packages/plugin 下跑 pnpm build。` }
  }
  return { ok: true, dir, manifest }
}

/**
 * 判断请求路径是否安全地落在根目录内。
 *
 * 三层都要查：字面 `..`、解析后的绝对路径前缀、以及**符号链接的真实路径**
 * （dist 里放个指向 `C:\` 的符号链接就能绕过前两层）。
 *
 * @param {string} root 已经 realpath 过的根
 * @param {string} requestPath URL 的 pathname
 * @returns {string | undefined} 安全的绝对路径；不安全返回 undefined
 */
export function safeWithin(root, requestPath) {
  let decoded
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return undefined // 非法转义
  }
  // 明确挡掉空字节与回溯段（即便后面 realpath 也能挡，早拒更清楚）
  if (decoded.includes('\0')) return undefined
  const relative = decoded.replace(/^\/+/, '')
  if (relative.split('/').some((part) => part === '..')) return undefined
  const candidate = resolve(root, relative === '' ? 'index.html' : relative)
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined
  // 符号链接逃逸
  try {
    const real = realpathSync(candidate)
    if (real !== root && !real.startsWith(root + sep)) return undefined
    return real
  } catch {
    return undefined
  }
}

/**
 * 探一下某个端口上是不是已经在发我们要发的东西。
 *
 * 用途：`EADDRINUSE` 有两种完全不同的成因 ——
 *   (a) 上一个插件实例没退干净 / 用户已经用同样的方式托管着 → **接管**即可，不该报错
 *   (b) 端口被别的东西占了（自己的 nginx、别人的服务）→ 必须报错，别乱连
 *
 * 判据就是 `manifest.json` 里的 `name` 与 `code`：只有对得上才认。
 *
 * @param {string} url
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, ours: boolean, name?: string }>}
 */
async function inspectManifest(url, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return { ok: false, ours: false }
    const body = await response.json()
    return {
      ok: true,
      // upstream 的 manifest 就叫这个名字、入口就是 plugin.js
      ours: body?.name === 'Penpot MCP Plugin' || body?.code === 'plugin.js',
      name: typeof body?.name === 'string' ? body.name : undefined,
    }
  } catch {
    return { ok: false, ours: false }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 起一个静态服务。
 *
 * @param {object} options
 * @param {string} options.dir dist 目录
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ ok: true, url: string, port: number, adopted: boolean, close: () => Promise<void> } | { ok: false, reason: string }>}
 */
export async function startPluginHost(options) {
  const { dir, host = '127.0.0.1', port = 4400, log = () => {} } = options
  let root
  try {
    root = realpathSync(dir)
  } catch (error) {
    return { ok: false, reason: `打不开产物目录：${String(error?.message ?? error)}` }
  }
  const manifest = join(root, 'manifest.json')
  if (!existsSync(manifest)) return { ok: false, reason: `${root} 里没有 manifest.json` }

  const server = createServer((req, res) => {
    const method = String(req.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    let pathname
    try {
      pathname = new URL(req.url ?? '/', 'http://plugin.internal').pathname
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const file = safeWithin(root, pathname)
    if (file === undefined) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    let stat
    try {
      stat = statSync(file)
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    // 目录请求回落 index.html，够用且不会列出内容
    const target = stat.isDirectory() ? join(file, 'index.html') : file
    const type = MIME[extname(target).toLowerCase()]
    if (type === undefined) {
      res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('unsupported file type')
      return
    }
    res.writeHead(200, {
      'content-type': type,
      // Penpot 页面在另一个域下：这个头是必须的
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    })
    if (method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(target).pipe(res).on('error', () => res.destroy())
  })

  const started = await new Promise((resolvePromise) => {
    const onError = (error) => {
      server.removeListener('listening', onListening)
      const code = error?.code ?? ''
      const reason = code === 'EADDRINUSE'
        ? `端口 ${port} 已被占用（可能是上一次没退干净的插件服务，或 upstream 的 vite preview）`
        : `起不来：${String(error?.message ?? error)}`
      resolvePromise({ ok: false, reason, code })
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolvePromise({ ok: true })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })

  if (started.ok !== true) {
    // EADDRINUSE 分两种：对面就是我们要发的东西（接管），还是别人（报错）
    if (started.code === 'EADDRINUSE') {
      const probe = await inspectManifest(`http://${host}:${port}/manifest.json`)
      if (probe.ok && probe.ours) {
        log(`端口 ${port} 上已经有一个 Penpot 插件 UI 在跑（${probe.name ?? '未命名'}），直接接管`)
        return {
          ok: true,
          url: `http://${host}:${port}/manifest.json`,
          port,
          adopted: true,
          close: async () => {}, // 不是我们起的，别去关别人的服务
        }
      }
      return {
        ok: false,
        reason: `端口 ${port} 被别的服务占着${probe.ok ? `（manifest 名字是「${probe.name ?? '未知'}」，不是 Penpot 插件）` : ''} —— 换 local.pluginPort，或先把它停掉`,
      }
    }
    return started
  }

  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  const url = `http://${host}:${actualPort}/manifest.json`
  log(`插件 UI 已托管：${url}`)
  return {
    ok: true,
    url,
    port: actualPort,
    adopted: false,
    close: () => new Promise((resolvePromise) => {
      server.close(() => resolvePromise())
      // 有长连接时会挂住，这里给个兜底
      setTimeout(() => resolvePromise(), 1000).unref?.()
    }),
  }
}

/** 供测试用。 */
export const _internal = { MIME, DEFAULT_PLUGIN_DIR, dirname }
