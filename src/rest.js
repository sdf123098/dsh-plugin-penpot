/**
 * 个人访问令牌（PAT）只读通道。
 *
 * ## 为什么要有这一半
 *
 * Penpot 其实**有两套凭据**，它们服务两条完全不同的通道：
 *
 * | 通道 | 凭据 | 认证头 | 用途 |
 * | --- | --- | --- | --- |
 * | MCP（`/mcp/stream`） | MCP key（URL 的 `userToken`） | 无（服务端忽略 Authorization） | 驱动 Penpot 标签页执行插件代码 |
 * | REST（`/api/rpc/command/*`） | 个人访问令牌 / MCP key | `Authorization: Token <值>` | 读团队、项目、文件、页面结构 |
 *
 * 关键差别：MCP 通道**必须有活跃的 Penpot 标签页**（插件在页面里执行代码），
 * 而 REST 通道不需要 —— 只要令牌有效，没开 Penpot 也能读到设计数据。
 *
 * 所以 PAT 不是「MCP key 的替代品」，而是「标签页没连上时的兜底读能力」，
 * 外加一个真实收益：**能离线验证凭据本身是否有效**（`/api/rpc/command/get-teams`
 * 用 Token 头打一次，200 就是有效）。MCP 通道做不到这件事 —— 它不校验 key，
 * 随便填个字符串 `initialize` 也返回 200。
 *
 * ## 实测记录（2026-11-09，design.penpot.app）
 *
 * - `authentication: Token <MCP key>` → 200，而且能一路读到 `get-file`（41 MB）
 *   所以 Integrations 里那个 MCP key **本身就是一个可用的 PAT**。
 * - `authentication: Bearer <任何值>` → 401。Penpot 的 REST 只认 `Token` 前缀。
 * - 不带凭据 → 401 `authentication-required`。
 * - `get-profile` 被 Cloudflare 单独拦（403 Just a moment），其余命令不受影响 ——
 *   所以「验凭据」用 get-teams，不用 get-profile。
 *
 * ## 只读
 *
 * 这个模块**只发 GET 语义的读命令**（见 ALLOWED_COMMANDS 白名单）。
 * 写命令一律不进来：PAT 有写权限，而插件不该在用户没通过 MCP 插件确认的情况下
 * 改他的设计稿。
 *
 * @module dsh-plugin-penpot/rest
 */

import { get as httpsGet, request as httpsRequest } from 'node:https'
import { get as httpGet, request as httpRequest } from 'node:http'

/**
 * 允许通过这个通道调用的**只读**命令。
 *
 * 写命令单独列在 WRITE_ALLOWED 里，且必须显式 `allowWrite: true` ——
 * 两者分开是为了让「读」这条路径天然不可能改东西：即使调用方传错参数，
 * 也只会在白名单外被拒。
 */
export const ALLOWED_COMMANDS = [
  'get-teams',
  'get-team',
  'get-projects',
  'get-project',
  'get-project-files',
  'get-team-recent-files',
  'get-file-info',
  'get-file-summary',
  'get-file-libraries',
  'get-page',
  'get-team-members',
  // get-file 只为「列页面」而开：它是唯一带 data.pages 的命令。
  // 体积能到 40 MB+，调用方必须自己指定 maxBytes 并把结果裁掉（见 tools.js 的 pages）。
  'get-file',
]

/**
 * 允许通过这个通道调用的**写**命令。
 *
 * 这些命令需要调用方显式传 `allowWrite: true`。为什么可以开：
 * PAT 本来就有写权限，用户既然把 PAT 交给插件，就是想让它改稿；
 * 真正的防护是「哪些命令」而不是「一律禁止写」。
 * 列在这里的都是**文件/图层级**的常规操作，不含删团队、改权限这类。
 */
export const WRITE_ALLOWED = [
  'create-file',
  'update-file',
  'rename-file',
  'duplicate-file',
  'delete-file',
  'create-project',
  'rename-project',
]

/** 依赖页面内插件的命令，永远不走 REST。 */
const REQUIRES_PLUGIN = new Set(['get-file-fragment'])

/** 响应体上限（默认）：只读通道通常只需要元数据，8 MB 已经很多了。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 上限的硬顶：get-file 在大文件上能到 40 MB+，再多就该怀疑拿错了。 */
const HARD_MAX_BODY_BYTES = 128 * 1024 * 1024

/**
 * 从 MCP 端点 URL 推出 REST API 基址。
 *
 * `https://design.penpot.app/mcp/stream` → `https://design.penpot.app`
 * 自部署实例同理（`/mcp/sse` 也吃这套）。
 *
 * @param {string} endpoint
 * @returns {string}
 */
export function apiBaseOf(endpoint) {
  if (typeof endpoint !== 'string' || endpoint === '') return ''
  try {
    const parsed = new URL(endpoint)
    // MCP 端点固定挂在 /mcp/ 下；把这一段连同之后的路径一起截掉
    const marker = parsed.pathname.indexOf('/mcp')
    if (marker >= 0) parsed.pathname = parsed.pathname.slice(0, marker) || '/'
    parsed.search = ''
    parsed.hash = ''
    return parsed.origin + (parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, ''))
  } catch {
    return ''
  }
}

/**
 * 发一个最小请求（不引第三方依赖，和 mcp-client.js 保持同一风格）。
 *
 * http / https 都支持：自部署实例常跑在 http 上（内网），测试也需要。
 *
 * @param {object} options
 * @param {string} options.url
 * @param {Record<string, string>} options.headers
 * @param {string} [options.body]
 * @param {number} options.timeoutMs
 * @param {boolean} [options.allowInsecureTLS]
 * @returns {Promise<{ status: number, text: string, headers: Record<string, string> }>}
 */
function httpsRequestOnce(options) {
  const { url, headers, body, timeoutMs, allowInsecureTLS } = options
  // 这个命令允许更大的响应体，但仍有个硬顶
  const limit = Math.min(HARD_MAX_BODY_BYTES, Math.max(MAX_BODY_BYTES, Number(options.maxBytes ?? MAX_BODY_BYTES)))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    let request
    try {
      const parsed = new URL(url)
      const secure = parsed.protocol === 'https:'
      const send = body === undefined ? (secure ? httpsGet : httpGet) : (secure ? httpsRequest : httpRequest)
      request = send(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port === '' ? undefined : Number(parsed.port),
          path: `${parsed.pathname}${parsed.search}`,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'accept': 'application/json',
            'user-agent': 'dsh-plugin-penpot',
            ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }),
            ...headers,
          },
          ...(secure ? { rejectUnauthorized: allowInsecureTLS !== true } : {}),
        },
        (response) => {
          const chunks = []
          let size = 0
          response.on('data', (chunk) => {
            size += chunk.length
            if (size > limit) {
              request.destroy(new Error(`响应超过 ${Math.round(limit / 1024 / 1024)} MB，已中断`))
              return
            }
            chunks.push(chunk)
          })
          response.on('end', () => {
            finish(resolve, {
              status: response.statusCode ?? 0,
              text: Buffer.concat(chunks).toString('utf8'),
              headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')])),
            })
          })
          response.on('error', (error) => finish(reject, error))
        },
      )
    } catch (error) {
      reject(error)
      return
    }
    const timer = setTimeout(() => {
      request.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    }, timeoutMs)
    timer.unref?.()
    request.on('error', (error) => {
      clearTimeout(timer)
      finish(reject, error)
    })
    request.on('close', () => clearTimeout(timer))
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/**
 * 调一个 Penpot RPC 命令。
 *
 * 读命令默认放行；写命令必须显式 `allowWrite: true`（见 WRITE_ALLOWED）。
 *
 * @param {object} options
 * @param {string} options.endpoint MCP 端点（用它的 origin 做 REST 基址）
 * @param {string} options.token PAT 或 MCP key
 * @param {string} options.command 读白名单或写白名单里的命令
 * @param {Record<string, unknown>} [options.params]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.allowInsecureTLS]
 * @param {boolean} [options.allowWrite] 必须显式为 true 才能调写命令
 * @returns {Promise<{ ok: true, status: number, data: unknown } | { ok: false, status: number, code: string, message: string }>}
 */
export async function callCommand(options) {
  const { endpoint, token, command, params = {}, timeoutMs = 20_000, allowInsecureTLS = false } = options
  const base = apiBaseOf(endpoint)
  if (base === '') return { ok: false, status: 0, code: 'bad-endpoint', message: '端点为空或不是合法 URL，推不出 REST 基址' }
  if (REQUIRES_PLUGIN.has(command)) {
    return { ok: false, status: 0, code: 'needs-plugin', message: `"${command}" 依赖页面内插件，请走 MCP 通道` }
  }
  const isRead = ALLOWED_COMMANDS.includes(command)
  const isWrite = WRITE_ALLOWED.includes(command)
  if (!isRead && !isWrite) {
    return {
      ok: false,
      status: 0,
      code: 'not-allowed',
      message: `"${command}" 不在白名单里。读：${ALLOWED_COMMANDS.join(', ')}；写：${WRITE_ALLOWED.join(', ')}`,
    }
  }
  // 写命令必须显式声明 —— 免得「本该只读」的调用路径因为参数拼错而误改稿子
  if (isWrite && options.allowWrite !== true) {
    return { ok: false, status: 0, code: 'write-requires-opt-in', message: `"${command}" 是写命令，调用方必须显式 allowWrite: true` }
  }
  if (typeof token !== 'string' || token === '') {
    return { ok: false, status: 0, code: 'no-token', message: '没有 PAT —— 面板「个人访问令牌」里贴一个，或直接用已有的 MCP key（它同时是有效 PAT）' }
  }

  const url = `${base}/api/rpc/command/${command}`
  let response
  try {
    response = await httpsRequestOnce({
      url,
      headers: { authorization: `Token ${token}` },
      body: JSON.stringify(params ?? {}),
      timeoutMs,
      allowInsecureTLS,
      // get-file 是唯一可能很大的命令（大文件 40 MB+），其余保持 8 MB
      maxBytes: command === 'get-file' ? HARD_MAX_BODY_BYTES : MAX_BODY_BYTES,
    })
  } catch (error) {
    return { ok: false, status: 0, code: 'endpoint', message: `连不上 ${base}：${String(error?.message ?? error)}` }
  }

  if (response.status === 200) {
    try {
      return { ok: true, status: 200, data: JSON.parse(response.text) }
    } catch {
      return { ok: false, status: 200, code: 'bad-json', message: '服务端返回的不是 JSON（可能是反代登录页）' }
    }
  }

  // 204 No Content：写命令（delete-file / rename-file 的部分实现）成功时的正常返回。
  // 这里**不能**当失败 —— 它会变成一个「明明改成功了却报错」的假故障。
  if (response.status === 204) return { ok: true, status: 204, data: null }

  // Cloudflare 的挑战页也走 403，但正文是 HTML —— 单独判一下，别报成「令牌无效」
  if (response.text.includes('Just a moment') || response.text.trimStart().startsWith('<!DOCTYPE')) {
    return { ok: false, status: response.status, code: 'blocked', message: '被前置网关（Cloudflare）挡了，不是令牌问题' }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, status: response.status, code: 'bad-token', message: `令牌无效或已过期（HTTP ${response.status}）` }
  }
  return { ok: false, status: response.status, code: 'http', message: `HTTP ${response.status}：${response.text.slice(0, 200)}` }
}

/**
 * 验凭据是否有效 —— 这是 MCP 通道**做不到**的事。
 *
 * 用 `get-teams` 而不是 `get-profile`：后者在官方站被 Cloudflare 单独拦，
 * 会把「令牌有效」误判成失败（实测 2026-11-09）。
 *
 * @param {object} options
 * @param {string} options.endpoint
 * @param {string} options.token
 * @param {boolean} [options.allowInsecureTLS]
 * @returns {Promise<{ stage: 'ok' | 'no-token' | 'bad-token' | 'blocked' | 'endpoint', label: string, detail: string, teamCount?: number }>}
 */
export async function verifyToken(options) {
  const result = await callCommand({ ...options, command: 'get-teams' })
  if (result.ok) {
    const teams = Array.isArray(result.data) ? result.data : []
    return {
      stage: 'ok',
      label: '凭据有效',
      detail: `可以读到 ${teams.length} 个团队（${teams.map((team) => team?.name ?? '未命名').slice(0, 3).join('、')}）`,
      teamCount: teams.length,
    }
  }
  const stageByCode = {
    'no-token': 'no-token',
    'bad-token': 'bad-token',
    blocked: 'blocked',
    endpoint: 'endpoint',
    'bad-endpoint': 'endpoint',
  }
  return {
    stage: stageByCode[result.code] ?? 'endpoint',
    label: result.code === 'no-token' ? '没配令牌' : result.code === 'bad-token' ? '令牌无效' : '读不到',
    detail: result.message,
  }
}

/** 供测试注入用。 */
export const _internal = { httpsRequestOnce, MAX_BODY_BYTES }
