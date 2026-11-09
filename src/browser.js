/**
 * 无人值守地打开 Penpot 设计稿（用**自己的**浏览器实例，不碰你的默认浏览器）。
 *
 * ## 为什么需要这个模块
 *
 * Penpot 的 MCP 通道靠 `execute_code` 在设计稿标签页里跑插件代码，所以那一段
 * 必须有浏览器。但「自动化」的前提是不能要求人手动开网页 ——
 * 更不该假设用户开着 Chrome / Edge（有人用 Zen、Firefox、Arc）。
 *
 * 这里的做法：**自己拉起一个独立的 Chromium 实例**，用专属 profile 目录，
 * 和用户的默认浏览器完全隔离。它只做一件事：把某个设计稿打开、让插件连上来。
 *
 * ## 为什么不直接用系统默认浏览器
 *
 * 因为要「驱动」就得有调试协议：
 *
 * | 浏览器 | 内核 | 可自动驱动 | 备注 |
 * | --- | --- | --- | --- |
 * | Chrome / Edge / Brave | Chromium | ✅ CDP | 本模块用这个 |
 * | Zen / Firefox | Gecko | ❌ 没有 CDP | 手动加载插件可以，脚本驱动不行 |
 * | Safari | WebKit | ❌ | 同上 |
 *
 * Zen 用户也不用担心：**插件本身是浏览器无关的**（Penpot 把它放在 iframe 里跑），
 * 你可以照常在自己的 Zen 里 `从 URL 载入`。这个模块只是给「不想开浏览器」的场景兜底。
 *
 * 而且更根本的一点：**绝大多数自动化根本不需要浏览器** —— 见 `design.js` 的
 * REST 写通道（建文件、加图层、改属性、删图层全都能做）。
 *
 * ## 登录态怎么处理
 *
 * 独立 profile = 一份新的 cookie 罐，所以**第一次需要登录一次**。之后它留着，
 * 后续自动化都能复用。profile 目录放在 `<DSH_HOME>/data/dsh-plugin-penpot/browser/<名字>`，
 * 和用户自己的浏览器数据完全不交叉。
 *
 * @module dsh-plugin-penpot/browser
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { dshHome } from './store.js'

/** 能驱动的浏览器候选（按优先级）。 */
const CHROMIUM_CANDIDATES = {
  win32: [
    ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'],
    ['chrome', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'],
    ['edge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['edge', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'],
    ['brave', 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
    ['brave', 'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ],
  darwin: [
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    ['brave', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  ],
  linux: [
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/google-chrome-stable'],
    ['chromium', '/usr/bin/chromium'],
    ['chromium', '/usr/bin/chromium-browser'],
    ['edge', '/usr/bin/microsoft-edge'],
    ['brave', '/usr/bin/brave-browser'],
  ],
}

/** 本地用户目录里的候选（Windows 上 Chrome 常装在这里）。 */
const LOCAL_SUFFIX = {
  win32: [
    ['chrome', 'Google\\Chrome\\Application\\chrome.exe'],
    ['edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
  ],
}

/**
 * 找可驱动的浏览器。
 *
 * @param {object} [options]
 * @param {string} [options.explicit] 配置里手动指定的路径
 * @returns {{ ok: true, kind: string, path: string } | { ok: false, reason: string, tried: string[] }}
 */
export function findChromium(options = {}) {
  const explicit = options.explicit
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const path = explicit.trim()
    return existsSync(path)
      ? { ok: true, kind: 'custom', path }
      : { ok: false, reason: `配置里指定的浏览器不存在：${path}`, tried: [path] }
  }
  const tried = []
  for (const [kind, path] of CHROMIUM_CANDIDATES[process.platform] ?? []) {
    tried.push(path)
    if (existsSync(path)) return { ok: true, kind, path }
  }
  // Windows 的 per-user 安装位置
  const localAppData = process.env.LOCALAPPDATA
  if (process.platform === 'win32' && typeof localAppData === 'string' && localAppData !== '') {
    for (const [kind, suffix] of LOCAL_SUFFIX.win32) {
      const path = join(localAppData, suffix)
      tried.push(path)
      if (existsSync(path)) return { ok: true, kind, path }
    }
  }
  return {
    ok: false,
    reason: process.platform === 'win32' || process.platform === 'darwin'
      ? '没找到可以自动驱动的 Chromium 系浏览器（Chrome / Edge / Brave）。'
        + '你现在的默认浏览器是 Zen（Firefox 内核），它没有 Chrome DevTools 协议，脚本驱动不了；'
        + '但**大多数自动化并不需要浏览器** —— 用 penpot_write 走 REST 就能建文件、加图层、改属性。'
      : '没找到可以自动驱动的 Chromium 系浏览器（chrome / chromium / edge / brave）。',
    tried,
  }
}

/** 专属 profile 目录（和用户自己的浏览器完全隔离）。 */
export function profileDir() {
  return join(dshHome(), 'data', 'dsh-plugin-penpot', 'browser', 'profile')
}

/** 本模块记的运行时信息（pid / 端口 / 当前打开的页面）。 */
function stateFile() {
  return join(dshHome(), 'data', 'dsh-plugin-penpot', 'browser.json')
}

/** @returns {{ pid?: number, port?: number, url?: string, openedAt?: string, browser?: string }} */
export function readBrowserState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeBrowserState(value) {
  try {
    mkdirSync(join(dshHome(), 'data', 'dsh-plugin-penpot'), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(value, null, 2), 'utf8')
  } catch {
    // 记不下来不影响运行
  }
}

function clearBrowserState() {
  try { rmSync(stateFile(), { force: true }) } catch { /* ignore */ }
}

/** 进程是否还活着（只查存活，不查身份 —— pid 复用概率在秒级窗口内极低）。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 等 CDP 端点就绪。
 *
 * @param {number} port
 * @param {number} timeoutMs
 */
async function waitForCdp(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) {
        const info = await response.json()
        return { ok: true, browser: typeof info?.Browser === 'string' ? info.Browser : 'unknown' }
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = String(error?.message ?? error)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return { ok: false, reason: lastError }
}

/**
 * 一个极简的 CDP 客户端。
 *
 * 为什么不引 puppeteer：只用得到 `Page.navigate` 和 `Runtime.evaluate`，
 * 为这两个命令拖一个 30 MB 的依赖不值得。Node 24+ 自带 WebSocket，够用。
 */
class CdpClient {
  /** @param {string} wsUrl */
  constructor(wsUrl) {
    this.wsUrl = wsUrl
    this.nextId = 1
    this.pending = new Map()
  }

  async connect(timeoutMs = 8000) {
    // 全局 WebSocket 是 Node 22+ 才稳的（20 里要 --experimental-websocket）。
    // 这里显式判一下，别让老 Node 上抛一个看不懂的 ReferenceError。
    if (typeof WebSocket !== 'function') {
      throw new Error(
        `当前 Node ${process.version} 没有全局 WebSocket，无法驱动浏览器。`
        + ' 升级到 Node 22+ 即可；或者干脆不用这条路，penpot_write 走 REST 不需要浏览器。',
      )
    }
    this.socket = new WebSocket(this.wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP 连接超时（${timeoutMs}ms）`)), timeoutMs)
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      this.socket.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(`CDP 连接失败：${event?.message ?? 'unknown'}`))
      })
    })
    this.socket.addEventListener('message', (event) => {
      let message
      try { message = JSON.parse(event.data) } catch { return }
      if (message.id === undefined) return
      const settle = this.pending.get(message.id)
      if (settle === undefined) return
      this.pending.delete(message.id)
      settle(message)
    })
    return this
  }

  send(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, 15_000)
      this.pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error !== undefined) reject(new Error(`CDP ${method}：${message.error.message ?? 'error'}`))
        else resolve(message.result)
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    try { this.socket?.close() } catch { /* ignore */ }
  }
}

/**
 * 拼 Penpot workspace 的地址。
 *
 * ## 为什么光有 file-id 不够
 *
 * Penpot 的 workspace 路由**要三个参数**：`team-id` + `file-id`（+ 可选 `page-id`）。
 * 只给 `file-id` 时它不报错，而是安静地重定向回 dashboard —— 看起来像「没权限」，
 * 其实是参数不全。这个坑实测踩过：打开设计稿后落到 dashboard，
 * 而 `hasApp` 是 true、也没有任何报错，很容易误判成权限问题。
 *
 * @param {string} appUrl
 * @param {{ fileId?: string, teamId?: string, pageId?: string }} ids
 * @returns {string}
 */
export function workspaceUrl(appUrl, ids = {}) {
  const fileId = typeof ids.fileId === 'string' ? ids.fileId.trim() : ''
  if (fileId === '') return `${appUrl}/`
  const params = new URLSearchParams()
  params.set('screen', 'workspace')
  const teamId = typeof ids.teamId === 'string' ? ids.teamId.trim() : ''
  const pageId = typeof ids.pageId === 'string' ? ids.pageId.trim() : ''
  if (teamId !== '') params.set('team-id', teamId)
  params.set('file-id', fileId)
  if (pageId !== '') params.set('page-id', pageId)
  return `${appUrl}/?${params.toString()}`
}

/**
 * 打开（或复用）一个设计稿。
 *
 * 复用规则：同一个进程还活着 + 同一个 fileId → 只是导航一下，不重开浏览器。
 *
 * @param {object} options
 * @param {string} [options.fileId] 不给就打开 Penpot 首页
 * @param {string} [options.teamId] **必须给**，否则 Penpot 会踢回 dashboard
 * @param {string} [options.pageId]
 * @param {string} [options.appUrl] Penpot 站点根地址（官方或自部署）
 * @param {string} [options.browserPath] 手动指定浏览器
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.headless]
 * @param {(message: string) => void} [options.log]
 */
export async function openDesign(options = {}) {
  const appUrl = (options.appUrl ?? 'https://design.penpot.app').replace(/\/+$/, '')
  const log = options.log ?? (() => {})
  const target = workspaceUrl(appUrl, options)
  const fileId = typeof options.fileId === 'string' ? options.fileId.trim() : ''
  if (fileId !== '' && (typeof options.teamId !== 'string' || options.teamId.trim() === '')) {
    // 不硬拦：Penpot 自己会把它重定向到 dashboard，但那样用户看到的是一张
    // 空白的最近文件页，完全不知道发生了什么。留一条日志至少能查。
    log('警告：给了 fileId 但没给 teamId —— Penpot 会把 workspace 重定向到 dashboard')
  }

  const found = findChromium({ explicit: options.browserPath })
  if (found.ok !== true) return { ok: false, reason: found.reason, tried: found.tried }

  const state = readBrowserState()
  // 还活着就复用（省掉一次冷启动，也不需要重新登录）
  if (Number.isInteger(state.pid) && isAlive(state.pid) && Number.isInteger(state.port)) {
    const ready = await waitForCdp(state.port, 1500)
    if (ready.ok) {
      const navigated = await navigateExisting(state.port, target, appUrl)
      if (navigated.ok) {
        writeBrowserState({ ...state, url: target, openedAt: new Date().toISOString() })
        log(`复用已有浏览器（pid ${state.pid}），导航到 ${target}`)
        return { ok: true, reused: true, port: state.port, url: target, browser: state.browser, loggedIn: navigated.loggedIn }
      }
    }
    // 进程在但 CDP 不理人：当垃圾清掉重开
    log('已有浏览器进程还在，但调试端口没响应，重开一个')
  }

  const dir = profileDir()
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    return { ok: false, reason: `建不了 profile 目录 ${dir}：${String(error?.message ?? error)}` }
  }

  const port = await pickPort()
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,CalculateNativeWinOcclusion',
    '--window-size=1440,900',
    // ## 为什么这几个开关是必须的
    //
    // 窗口最小化、或被别的窗口完全遮住时，Chromium 会**冻结**渲染进程：
    // 定时器和 rAF 停摆，WebSocket 心跳断掉。而 Penpot 的插件是跑在设计稿
    // 标签页里的 —— 一旦冻结，上游 MCP 服务端就会报
    // 「The Penpot plugin tab has been frozen by the browser and cannot run tasks」，
    // 所有 execute_code 全部失效，只能人工点一下那个窗口才能恢复。
    //
    // 对「无人值守」来说这是致命的。这四个开关分别关掉：
    //   - 后台标签页的定时器节流
    //   - 被遮挡窗口的降频
    //   - 渲染进程的后台优先级
    //   - 原生窗口遮挡检测（Windows 上最坑的一个，最小化即冻结）
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    target,
  ]
  if (options.headless === true) args.unshift('--headless=new')

  const child = spawn(found.path, args, { detached: true, stdio: 'ignore' })
  child.unref()
  writeBrowserState({ pid: child.pid, port, url: target, openedAt: new Date().toISOString(), browser: found.kind })

  const ready = await waitForCdp(port, options.timeoutMs ?? 20_000)
  if (ready.ok !== true) {
    // 起不来就清掉记录，别让下次误以为还活着
    clearBrowserState()
    return {
      ok: false,
      reason: `浏览器起来了但调试端口 ${port} 没就绪（${ready.reason}）。`
        + '可能是被安全软件拦了，或这个端口被占。',
      browser: found.kind,
      path: found.path,
    }
  }

  const navigated = await navigateExisting(port, target, appUrl)
  log(`已用 ${found.kind} 打开 ${target}（独立 profile：${dir}）`)
  return {
    ok: true,
    reused: false,
    port,
    pid: child.pid,
    url: target,
    browser: found.kind,
    browserPath: found.path,
    profile: dir,
    loggedIn: navigated.loggedIn === true,
    loginHint: navigated.loggedIn === true
      ? undefined
      : '这是独立的浏览器 profile，第一次需要在这里登录一次 Penpot；之后自动化会直接复用登录态。',
  }
}

/** 找一个空闲端口（CDP 要一个确定的值，不能让它自己挑）。 */
async function pickPort() {
  const net = await import('node:net')
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(9222))
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 读页面当前状态（URL / 标题 / 有没有应用容器）。
 *
 * 表达式必须**自己容错**：刚导航过去时 `document.body` 还是 null，
 * 一抛异常 CDP 就回 exceptionDetails 而不是值，`returnByValue` 拿到 undefined ——
 * 看起来像「页面没内容」，实际只是读早了。
 *
 * @param {CdpClient} client
 */
async function readPageInfo(client) {
  const expression = `(() => { try {
    const body = document.body
    return JSON.stringify({
      url: location.href,
      title: document.title || '',
      hasApp: !!document.querySelector('#app'),
      bodyText: body ? (body.innerText || '').slice(0, 200) : '',
      readyState: document.readyState,
    })
  } catch (error) { return JSON.stringify({ url: location.href, error: String(error && error.message) }) } })()`
  const evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: true })
  const raw = evaluated?.result?.value
  if (typeof raw !== 'string') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/**
 * 轮询等前端路由稳定，再判登录态。
 *
 * 为什么要轮询：Penpot 是 SPA，导航提交后它会先渲染一帧未决页面、
 * 再在客户端路由里跳去 `/auth/login`。只在 2.5 秒后读一次，会赶在跳转之前
 * 读到「有 #app、URL 还没带 /auth/」—— 误判成已登录（实测踩过）。
 *
 * 判据三条全满足才算登录：URL 在目标站上、没停在登录页、能读到应用容器。
 *
 * @param {CdpClient} client
 * @param {string} [appOrigin]
 * @param {number} [timeoutMs]
 */
async function waitForLoginState(client, appOrigin, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  let info = {}
  let stableSince = 0
  let previousUrl = ''
  while (Date.now() < deadline) {
    info = await readPageInfo(client)
    const url = String(info.url ?? '')
    if (url === previousUrl && url !== '') {
      // 同一个 URL 连着看到两次 = 路由settle 了，可以下结论
      if (Date.now() - stableSince > 900) break
    } else {
      previousUrl = url
      stableSince = Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  const url = String(info.url ?? '')
  const onAuthPage = url.includes('/auth/') || /login|signin/i.test(url)
  const onApp = appOrigin === undefined || url.startsWith(appOrigin)
  const loggedIn = onApp && info.hasApp === true && !onAuthPage
  return { loggedIn, url, title: info.title }
}

/**
 * 在已有实例里导航到某个 URL，并判断是否已登录。
 *
 * ## 选标签页的坑（实测踩过）
 *
 * 浏览器的 `/json/list` 里不只有你的页面，还有 `chrome-extension://`、
 * `edge://sync-confirmation-dialog/` 这类**内部页**，而且它们可能排在你前面。
 * 一律「取第一个 type=page」会拿到内部页：导航虽然也能提交，但
 * `document.querySelector('#app')` 永远为空 —— 登录态判断就成了错的。
 *
 * 所以只认 `http(s)://`，并且优先找**已经在这个站上**的那个标签页。
 *
 * @param {number} port
 * @param {string} url
 * @param {string} [appOrigin] 用来优先匹配同站标签页
 */
async function navigateExisting(port, url, appOrigin) {
  let pages
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
    pages = await response.json()
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
  const usable = Array.isArray(pages)
    ? pages.filter((entry) => entry.type === 'page' && /^https?:\/\//i.test(String(entry.url)))
    : []
  // 同站优先：把它当作「用户已经登录的那个标签页」
  const page = (appOrigin === undefined
    ? undefined
    : usable.find((entry) => String(entry.url).startsWith(appOrigin))) ?? usable[0]

  if (page === undefined) {
    // 一个新 profile 可能只有 Edge 的同步对话框，一个 http 页面都没有。
    // 这时候用 /json/new 主动开一个（旧版要用 PUT，新版 GET 也行，两个都试）。
    return createAndNavigate(port, url, appOrigin)
  }

  const client = new CdpClient(page.webSocketDebuggerUrl)
  try {
    await client.connect()
    await client.send('Page.enable', {})
    await client.send('Page.navigate', { url })
    // 提到前台：后台标签页会被浏览器降频甚至冻结，Penpot 的插件就停了。
    // 顺序放在 navigate 之后 —— 先让它开始加载，再抢焦点，冷启动快一点。
    await client.send('Page.bringToFront', {}).catch(() => {})
    const state = await waitForLoginState(client, appOrigin)
    return { ok: true, ...state }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  } finally {
    client.close()
  }
}

/**
 * 用 DevTools 的 HTTP 接口新开一个标签页并导航。
 *
 * 为什么需要它：全新 profile 启动后可能一个 http 页面都没有（只有浏览器的
 * 首次运行/同步对话框），这时没有可用的 page 目标可以 `Page.navigate`。
 *
 * @param {number} port
 * @param {string} url
 */
async function createAndNavigate(port, url, appOrigin) {
  for (const method of ['PUT', 'GET']) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
        method,
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) continue
      await new Promise((resolve) => setTimeout(resolve, 2000))
      // 拿新开那个标签页读状态
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })).json()
      const created = (Array.isArray(pages) ? pages : [])
        .filter((entry) => entry.type === 'page' && /^https?:\/\//i.test(String(entry.url)))
        .find((entry) => appOrigin === undefined || String(entry.url).startsWith(appOrigin))
      if (created === undefined) continue
      const client = new CdpClient(created.webSocketDebuggerUrl)
      try {
        await client.connect()
        const state = await waitForLoginState(client, appOrigin)
        return { ok: true, ...state }
      } finally {
        client.close()
      }
    } catch {
      // 换下一个方法
    }
  }
  return { ok: false, reason: '浏览器里既没有可用标签页，也开不出新的' }
}

/**
 * 关掉这个模块拉起的浏览器（只关自己起的，绝不碰用户的默认浏览器）。
 */
export async function closeDesignBrowser(options = {}) {
  const state = readBrowserState()
  if (!Number.isInteger(state.pid)) {
    clearBrowserState()
    return { ok: true, closed: false, reason: '没有记录在案的浏览器实例' }
  }
  if (!isAlive(state.pid)) {
    clearBrowserState()
    return { ok: true, closed: false, reason: '实例已经退出了' }
  }
  // 先请它自己退（这样 profile 里的 cookie 才会落盘）
  const graceful = await (async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${state.port}/json/list`, { signal: AbortSignal.timeout(2000) })).json()
      const page = Array.isArray(pages) ? pages.find((entry) => entry.type === 'page') : undefined
      if (page === undefined) return false
      const client = new CdpClient(page.webSocketDebuggerUrl)
      await client.connect(3000)
      await client.send('Browser.close', {})
      client.close()
      return true
    } catch {
      return false
    }
  })()
  // 兜底：还活着就杀
  const deadline = Date.now() + (options.timeoutMs ?? 5000)
  while (Date.now() < deadline) {
    if (!isAlive(state.pid)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (isAlive(state.pid)) {
    try { process.kill(state.pid) } catch { /* ignore */ }
  }
  clearBrowserState()
  return { ok: true, closed: true, graceful, pid: state.pid }
}

/** 浏览器子系统的一行状态（面板与工具共用）。 */
export async function browseStatus() {
  const found = findChromium({ explicit: undefined })
  const state = readBrowserState()
  const alive = Number.isInteger(state.pid) && isAlive(state.pid)
  let cdp = false
  if (alive && Number.isInteger(state.port)) {
    cdp = (await waitForCdp(state.port, 800)).ok === true
  }
  return {
    available: found.ok === true,
    kind: found.ok === true ? found.kind : '',
    path: found.ok === true ? found.path : '',
    reason: found.ok === true ? '' : found.reason,
    running: alive && cdp,
    pid: alive ? state.pid : undefined,
    port: alive ? state.port : undefined,
    url: alive ? state.url : '',
    profile: profileDir(),
  }
}

/** 清掉整个浏览器 profile（换账号、或登录态坏了时用）。 */
export function resetBrowserProfile() {
  const state = readBrowserState()
  if (Number.isInteger(state.pid) && isAlive(state.pid)) {
    return { ok: false, reason: '浏览器还在跑，先关掉再重置 profile' }
  }
  const dir = profileDir()
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    clearBrowserState()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/** 供测试用。 */
export const _internal = { CHROMIUM_CANDIDATES, isAlive, CdpClient, readdirSync }
