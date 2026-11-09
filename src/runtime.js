/**
 * 本地运行时（只对 local 档）：拉起 / 接管 / 停止 Penpot MCP 服务器进程。
 *
 * 为什么不用 MCP SDK 的 StdioClientTransport 直接起子进程：
 *   - Penpot 的 MCP 服务器是**长期服务**，同一时刻还要给 Penpot 浏览器里的插件
 *     留一条 WebSocket（4402）。会话一断就跟着杀进程，插件那边会反复掉线。
 *   - 它的 REPL（4403）是给人用的，进程没了就看不到。
 * 所以这里自己 detached 起进程，再用 HTTP 连过去；进程独立于 DSH 会话存活
 * （"唤醒启动、并一直启动"就是这个意思），由 run.json 记录 pid 供下次接管或回收。
 *
 * 端口占用策略：**绝不盲杀**。发现端口有人监听时先验证对面是不是 penpot
 * （发一次 initialize，看工具集里有没有 execute_code），是就接管，不是就报错
 * 并给出占用者 PID 让用户自己决定。
 *
 * @module dsh-plugin-penpot/runtime
 */

import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync, mkdirSync, appendFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import net from 'node:net'
import { dataDir, writeRunRecord, readRunRecord } from './store.js'
import { errorText } from './mcp-client.js'

/** 本地进程日志文件。 */
export function logFile() {
  return join(dataDir(), 'logs', 'local-mcp.log')
}

function ensureLogDir() {
  mkdirSync(dirname(logFile()), { recursive: true })
}

/**
 * 探测端口是否有人监听。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function probePort(host, port, timeoutMs = 800) {
  return new Promise((resolvePromise) => {
    const socket = net.connect({ host, port })
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * 找出监听某端口的进程 PID 与命令行（Windows 优先，其余平台回落 lsof/ss）。
 *
 * @param {number} port
 * @returns {{ pid: number, name: string, command: string } | undefined}
 */
export function portOwner(port) {
  if (process.platform === 'win32') {
    const netstat = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    const line = String(netstat.stdout ?? '')
      .split(/\r?\n/)
      .find((row) => new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(row))
    if (line === undefined) return undefined
    const pid = Number.parseInt(line.trim().split(/\s+/).pop() ?? '', 10)
    if (!Number.isInteger(pid) || pid <= 0) return undefined
    const info = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true },
    )
    return { pid, name: '', command: String(info.stdout ?? '').trim() }
  }
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  const pid = Number.parseInt(String(lsof.stdout ?? '').trim().split(/\s+/)[0] ?? '', 10)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  return { pid, name: '', command: String(ps.stdout ?? '').trim() }
}

/** 这段命令行像不像 penpot MCP 服务器。 */
export function looksLikePenpot(command) {
  const value = String(command ?? '').toLowerCase()
  if (value === '') return false
  return /penpot/.test(value) || /packages[\\/]server[\\/]dist[\\/]index\.js/.test(value)
}

/**
 * 验证监听者确实是 penpot 的 MCP 服务器（而不是别的服务占了 4401）。
 *
 * 判据：initialize + tools/list 拿到 `execute_code`。
 *
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, tools?: string[], reason?: string }>}
 */
export async function verifyPenpotEndpoint(host, port, timeoutMs = 4000) {
  const url = `http://${host}:${port}/mcp`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'dsh-plugin-penpot/probe', version: '0.1.0' },
        },
      }),
      signal: controller.signal,
    })
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const text = await response.text()
    const payload = parseSseOrJson(text)
    if (payload?.result?.serverInfo?.name !== 'penpot' && !/penpot/i.test(text)) {
      return { ok: false, reason: 'initialize 响应里没有 penpot 的 serverInfo' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: errorText(error) }
  } finally {
    clearTimeout(timer)
  }
}

/** SSE 响应体里取第一条 `data:` 的 JSON；普通 JSON 直接 parse。 */
export function parseSseOrJson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined
  if (raw.startsWith('{')) {
    try { return JSON.parse(raw) } catch { return undefined }
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    try { return JSON.parse(line.slice(5).trim()) } catch { continue }
  }
  return undefined
}

/**
 * 找一个可用的 node 可执行文件。
 *
 * 优先级：显式配置 → 当前进程的 execPath（DSH 自带的 node 一定可用）→ PATH 上的 node。
 */
export function resolveNodePath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (typeof process.execPath === 'string' && /node/i.test(process.execPath)) return process.execPath
  return 'node'
}

/** 本地档要跑的入口与 cwd。 */
export function resolveLocalLaunch(config) {
  const local = config.local
  if (local.sub === 'npm') {
    const npmCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
    return {
      command: npmCmd,
      args: ['-y', `@penpot/mcp@${local.npmTag || 'stable'}`],
      // npx 包自己的 cwd：放数据目录下，避免污染用户当前项目
      cwd: join(dataDir(), 'npm'),
      label: `npx @penpot/mcp@${local.npmTag || 'stable'}`,
    }
  }
  const repoDir = resolve(local.repoDir || '.')
  const entry = local.entry || 'packages/server/dist/index.js'
  const entryAbs = resolve(repoDir, entry)
  // 关键：PenpotMcpServer 的 ConfigurationLoader 按 `process.cwd()` 找
  // `data/initial_instructions.md`，找不到就直接抛。
  // `pnpm run build` 会把 data/ 与 static/ 一起复制进 dist/（见 server 的
  // scripts/copy-resources.js），所以 cwd 必须是 **entry 所在的目录**（通常就是
  // packages/server/dist）。锁到 packages/server 也行，但那只是因为它自己也有一份
  // data/；按 entry 的目录走对两种构建布局都成立。
  const cwd = dirname(entryAbs)
  return {
    command: resolveNodePath(local.nodePath),
    args: [entryAbs],
    cwd,
    entryAbs,
    label: `node ${entryAbs}`,
  }
}

/** 本地档的环境变量（端口/日志级别/用户自定义）。 */
export function resolveLocalEnv(config) {
  const local = config.local
  const env = {
    ...process.env,
    // Penpot 默认绑 "localhost"，在 Windows 上常解析到 ::1，而探测/HTTP 走
    // 127.0.0.1 会对不上。统一钉死到 127.0.0.1。
    PENPOT_MCP_SERVER_HOST: local.host || '127.0.0.1',
    PENPOT_MCP_SERVER_PORT: String(local.httpPort),
    PENPOT_MCP_WEBSOCKET_PORT: String(local.wsPort),
    PENPOT_MCP_REPL_PORT: String(local.replPort),
    PENPOT_MCP_LOG_LEVEL: local.logLevel || 'info',
  }
  for (const [key, value] of Object.entries(local.env ?? {})) env[key] = String(value)
  return env
}

/**
 * 启动本地服务器（幂等：已在跑就接管）。
 *
 * @param {object} options
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ ok: true, adopted: boolean, pid?: number, url: string, ports: { http: number, ws: number, repl: number } } | { ok: false, error: string, hint?: string, owner?: { pid: number, command: string } }>}
 */
export async function startLocal(options) {
  const { config } = options
  const log = options.log ?? (() => {})
  const local = config.local
  const host = local.host || '127.0.0.1'
  const ports = { http: local.httpPort, ws: local.wsPort, repl: local.replPort }
  const url = `http://${host}:${ports.http}/mcp`

  // 1) 已经在监听？验证是 penpot 就接管。
  if (await probePort(host, ports.http)) {
    const verified = await verifyPenpotEndpoint(host, ports.http)
    if (verified.ok) {
      log(`端口 ${ports.http} 已有 penpot MCP 在跑，接管`)
      return { ok: true, adopted: true, url, ports }
    }
    const owner = portOwner(ports.http)
    return {
      ok: false,
      error: `端口 ${ports.http} 被占用，但对面不是 penpot MCP（${verified.reason ?? '验证失败'}）。`,
      hint: owner === undefined
        ? '换一个 httpPort，或关掉占用该端口的程序。'
        : `占用者 PID ${owner.pid}${owner.command === '' ? '' : `：${owner.command.slice(0, 200)}`}。插件不会替你杀进程 —— 换端口，或你自己确认后停掉它。`,
      owner: owner === undefined ? undefined : { pid: owner.pid, command: owner.command },
    }
  }

  // 2) 没在跑：检查入口存在。
  const launch = resolveLocalLaunch(config)
  if (local.sub === 'repo') {
    if (!existsSync(launch.entryAbs)) {
      return {
        ok: false,
        error: `找不到本地入口：${launch.entryAbs}`,
        hint: config.local.autoBuild
          ? '目录在但 dist 没构建。已开启 autoBuild，请在插件面板点「构建」或手动跑 pnpm run build。'
          : '先在该仓库跑 pnpm run build，或在面板里把「子选项」改成 npm（npx @penpot/mcp）。',
      }
    }
  }

  // 3) detached 启动，stdout/stderr 落文件（面板读尾部）。
  ensureLogDir()
  const logPath = logFile()
  appendFileSync(logPath, `\n${'='.repeat(72)}\n[${new Date().toISOString()}] start: ${launch.label}\n`)
  let fd
  try {
    fd = openSync(logPath, 'a')
  } catch (error) {
    return { ok: false, error: `打不开日志文件 ${logPath}：${errorText(error)}` }
  }

  mkdirSync(launch.cwd, { recursive: true })
  let child
  try {
    child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: resolveLocalEnv(config),
      stdio: ['ignore', fd, fd],
      detached: true,
      windowsHide: true,
    })
  } catch (error) {
    closeSync(fd)
    return { ok: false, error: `启动失败：${errorText(error)}`, hint: '检查 nodePath 是否指向真实存在的 node 可执行文件。' }
  }
  // 父进程关掉自己的 fd 副本，子进程继续持有。
  try { closeSync(fd) } catch {}

  let exited = undefined
  child.once('exit', (code, signal) => { exited = { code, signal } })
  child.once('error', (error) => { exited = { code: undefined, signal: undefined, error: errorText(error) } })
  child.unref()

  // 4) 等端口打开（最长 connectTimeoutMs）。
  const deadline = Date.now() + config.connectTimeoutMs
  while (Date.now() < deadline) {
    if (exited !== undefined) {
      const tail = readLogTail(40)
      return {
        ok: false,
        error: `本地进程刚启动就退出了（code=${exited.code ?? '?'}${exited.signal ? `, signal=${exited.signal}` : ''}）。`,
        hint: tail === '' ? '看面板「日志」区，或手动跑一次 launch 命令。' : `日志尾部：\n${tail}`,
      }
    }
    await new Promise((r) => setTimeout(r, 400))
    if (await probePort(host, ports.http)) {
      const verified = await verifyPenpotEndpoint(host, ports.http)
      if (verified.ok) {
        writeRunRecord({
          pid: child.pid ?? 0,
          ports,
          command: launch.label,
          cwd: launch.cwd,
          startedAt: new Date().toISOString(),
        })
        log(`本地 penpot MCP 已启动（pid ${child.pid}，${url}）`)
        return { ok: true, adopted: false, pid: child.pid, url, ports }
      }
    }
  }

  return {
    ok: false,
    error: `等了 ${config.connectTimeoutMs}ms，端口 ${ports.http} 仍未就绪。`,
    hint: readLogTail(30),
  }
}

/**
 * 停掉我们拉起的本地进程。
 *
 * 只杀 run.json 里记的那个 pid，且杀之前核一次命令行确实像 penpot —— 把 pid
 * 复用导致的误杀挡在门外。
 *
 * @param {object} [options]
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ ok: boolean, stopped: boolean, reason?: string }>}
 */
export async function stopLocal(options = {}) {
  const log = options.log ?? (() => {})
  const record = readRunRecord()
  if (record === undefined) return { ok: true, stopped: false, reason: '没有本地进程记录' }

  const pid = Number(record.pid)
  if (!Number.isInteger(pid) || pid <= 0) {
    writeRunRecord(undefined)
    return { ok: true, stopped: false, reason: '记录里的 pid 无效，已清理记录' }
  }

  if (!isProcessAlive(pid)) {
    writeRunRecord(undefined)
    log(`记录的 pid ${pid} 已经不在了，清掉记录`)
    return { ok: true, stopped: false, reason: '进程已不在' }
  }

  const command = processCommandOf(pid)
  if (command !== undefined && command !== '' && !looksLikePenpot(command)) {
    writeRunRecord(undefined)
    return {
      ok: false,
      stopped: false,
      reason: `pid ${pid} 现在跑的是别的程序（${command.slice(0, 160)}），不杀。已清掉过期记录。`,
    }
  }

  await terminateTree(pid)
  writeRunRecord(undefined)
  log(`已停止本地 penpot MCP（pid ${pid}）`)
  return { ok: true, stopped: true }
}

/** 进程是否还活着。 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 取某 pid 的命令行（拿不到返回 undefined）。 */
export function processCommandOf(pid) {
  if (process.platform === 'win32') {
    const info = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', windowsHide: true },
    )
    const text = String(info.stdout ?? '').trim()
    return text === '' ? undefined : text
  }
  const ps = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  const text = String(ps.stdout ?? '').trim()
  return text === '' ? undefined : text
}

/** 先礼后兵：SIGTERM，等 3 秒，再强杀。Windows 用 taskkill /T 带走整个进程树。 */
async function terminateTree(pid) {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true })
    for (let i = 0; i < 12; i++) {
      if (!isProcessAlive(pid)) return
      await new Promise((r) => setTimeout(r, 250))
    }
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    return
  }
  try { process.kill(pid, 'SIGTERM') } catch {}
  for (let i = 0; i < 12; i++) {
    if (!isProcessAlive(pid)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  try { process.kill(pid, 'SIGKILL') } catch {}
}

/**
 * 启动时的孤儿回收：上次 DSH 退出时留下的本地进程怎么办。
 *
 * 策略（按配置）：不杀。只要它还是 penpot，就**接管**它 —— 这正是「唤醒启动、
 * 并一直启动」的正向结果：DSH 重启后不用再等一次冷启动。用户想停就在面板点停止。
 *
 * 注意：`recoverOrphan` 只回答「能不能接管」，不负责建连 —— 建连由 service 做。
 *
 * @param {object} options
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{ adopted: boolean, pid?: number, note: string } | undefined>}
 */
export async function recoverOrphan(options) {
  const record = readRunRecord()
  if (record === undefined) return undefined
  const log = options.log ?? (() => {})
  const pid = Number(record.pid)
  if (!Number.isInteger(pid) || pid <= 0 || !isProcessAlive(pid)) {
    writeRunRecord(undefined)
    return undefined
  }
  const command = processCommandOf(pid)
  if (command !== undefined && command !== '' && !looksLikePenpot(command)) {
    writeRunRecord(undefined)
    return undefined
  }
  const host = options.config.local.host || '127.0.0.1'
  const port = Number(record.ports?.http ?? options.config.local.httpPort)
  if (await probePort(host, port)) {
    const verified = await verifyPenpotEndpoint(host, port)
    if (verified.ok) {
      log(`接管上次留下的本地实例（pid ${pid}，端口 ${port}）`)
      return { adopted: true, pid, note: `接管了上次留下的实例（pid ${pid}）` }
    }
  }
  return undefined
}

/**
 * 收尾：确保本进程不会因为「还有 socket / 子进程句柄」而挂着退出。
 *
 * 为什么需要：MCP SDK 的 StreamableHTTPClientTransport 在某些错误路径上会留下
 * 一个未 unref 的 socket，进程于是等不到自然退出 —— 表现为 `node --test` 卡住。
 * 这不是业务 bug，但会污染测试与 DSH 的干净退出，所以统一在这里收口。
 *
 * @param {import('./mcp-client.js').PenpotSession | undefined} session
 */
export async function drainSession(session) {
  if (session === undefined) return
  await session.close().catch(() => {})
  // 让 SDK 的 socket 有机会走到 close 回调。
  // 这个定时器**不能 unref**：unref 的定时器不维持事件循环，若此刻没有别的句柄，
  // 进程会直接退出而这个 await 永远不 resolve（实测会让 `node --test` 卡住并报
  // "Detected unsettled top-level await"）。150ms 的短暂 hold 是值得的。
  await new Promise((resolve) => setTimeout(resolve, 150))
}

/**
 * 读本地进程日志的尾部。
 *
 * @param {number} [lines]
 * @returns {string}
 */
export function readLogTail(lines = 120) {
  const path = logFile()
  if (!existsSync(path)) return ''
  try {
    const stat = statSync(path)
    // 只读尾部 256KB，日志可能很长
    const maxBytes = 256 * 1024
    const text = readFileSync(path, 'utf8')
    if (stat.size <= maxBytes) return tailLines(text, lines)
    return tailLines(text.slice(-maxBytes), lines)
  } catch {
    return ''
  }
}

function tailLines(text, lines) {
  const all = String(text ?? '').split(/\r?\n/)
  return all.slice(Math.max(0, all.length - lines)).join('\n')
}

/**
 * 构建状态摘要（面板与 penpot_status 共用）。
 *
 * @param {object} options
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} options.config
 * @param {{ state: string, adopted?: boolean, pid?: number, error?: string, lastError?: string, endpoint?: string, tools?: string[] }} options.runtime
 */
export async function describeLocal(options) {
  const { config, runtime } = options
  const local = config.local
  const host = local.host || '127.0.0.1'
  const listening = await probePort(host, local.httpPort)
  const record = readRunRecord()
  return {
    listening,
    pid: record?.pid ?? runtime.pid,
    ports: { http: local.httpPort, ws: local.wsPort, repl: local.replPort },
    replUrl: `http://${host}:${local.replPort}`,
    adopted: runtime.adopted === true,
    built: existsSync(resolve(resolve(local.repoDir || '.'), local.entry || 'packages/server/dist/index.js')),
  }
}
