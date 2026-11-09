/**
 * MCP 客户端：把「怎么连」和「连上之后干什么」隔开。
 *
 * 三档连接目标只有**两种传输**：
 *   - local  → stdio 子进程（我们自己 spawn，或接管已在监听的那个）
 *   - 远端   → streamable-http（主）/ sse（备），Penpot 官方两个端点都实现了
 *
 * 重要：Penpot 的鉴权是把 MCP key 作为 `userToken` 查询参数带在 URL 上，
 * 服务端**不认** `Authorization` 头（实测：带 Bearer 仍报 "No userToken found"）。
 * 所以这里从不往 requestInit 里塞 Authorization，token 一律拼进 URL。
 *
 * @module dsh-plugin-penpot/mcp-client
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

/** 本插件对上游暴露的客户端名（会出现在 Penpot 服务端日志里）。 */
const CLIENT_INFO = { name: 'dsh-plugin-penpot', version: '0.1.0' }

/** 探测失败的可读化：把 SDK 的嵌套 cause 剥成一行。 */
export function errorText(error) {
  if (error === undefined || error === null) return 'unknown error'
  let text = typeof error.message === 'string' ? error.message : String(error)
  let cause = error.cause
  let depth = 0
  while (cause !== undefined && cause !== null && depth < 4) {
    const inner = typeof cause.message === 'string' ? cause.message : String(cause)
    if (inner !== '' && !text.includes(inner)) text += `: ${inner}`
    cause = cause.cause
    depth++
  }
  if (typeof error.code === 'string' && !text.includes(error.code)) text += ` (${error.code})`
  return text
}

/**
 * 把 userToken 拼进 URL。已存在则不重复。
 *
 * @param {string} url
 * @param {string} token
 */
export function withToken(url, token) {
  if (typeof token !== 'string' || token === '') return url
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('userToken') === token) return url
    parsed.searchParams.set('userToken', token)
    return parsed.toString()
  } catch {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}userToken=${encodeURIComponent(token)}`
  }
}

/**
 * 从 Penpot 的报错文本判断这次调用停在哪个阶段。
 *
 * 这四句都是从真实服务端抓到的原文，是「没有 OAuth，只能靠报错判断」这个
 * 事实逼出来的分级手段 —— 见 README「鉴权真相」。
 *
 * @param {string} text
 * @returns {{ stage: 'endpoint' | 'no-token' | 'no-instance' | 'ok', detail: string }}
 */
export function classifyFailure(text) {
  const value = String(text ?? '')
  if (/No userToken found in session context/i.test(value)) {
    return { stage: 'no-token', detail: '缺 MCP key（URL 里没有 userToken）' }
  }
  if (/No Penpot instance connected for user token/i.test(value)) {
    return { stage: 'no-instance', detail: 'key 已带，但 Penpot 那边没有连上来（未点 Connect / key 过期 / key 不对）' }
  }
  if (/No Penpot plugin instances are currently connected/i.test(value)) {
    return { stage: 'no-instance', detail: 'MCP 服务器在，但 Penpot 里的插件没连上来' }
  }
  if (/Tool execution failed/i.test(value)) {
    return { stage: 'endpoint', detail: value.split('\n')[0].slice(0, 300) }
  }
  return { stage: 'endpoint', detail: value.slice(0, 300) }
}

/**
 * 一个已连上的 MCP 会话。
 *
 * 生命周期刻意做得「薄」：建连一次、拿一次工具表、之后按需调用；
 * 断线不自动重连（重连由上层 runtime 决定，因为它可能还要重启子进程）。
 */
export class PenpotSession {
  /**
   * @param {object} options
   * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} options.client
   * @param {{ close: () => Promise<void> }} options.transport
   * @param {'stdio' | 'http' | 'sse'} options.transportKind
   * @param {string} options.endpoint 脱敏后的端点描述
   * @param {{ name: string, description?: string, inputSchema?: unknown }[]} options.tools
   * @param {number} options.toolCallTimeoutMs
   * @param {string} [options.instructions]
   */
  constructor(options) {
    this.client = options.client
    this.transport = options.transport
    this.transportKind = options.transportKind
    this.endpoint = options.endpoint
    this.tools = options.tools
    this.toolCallTimeoutMs = options.toolCallTimeoutMs
    this.instructions = options.instructions
    this.closed = false
  }

  /** 上游工具名清单。 */
  toolNames() {
    return this.tools.map((tool) => tool.name)
  }

  /** 上游是否有某个工具（决定 UI 上哪些按钮可用）。 */
  has(toolName) {
    return this.tools.some((tool) => tool.name === toolName)
  }

  /**
   * 调一个上游工具，返回归一化结果。
   *
   * @param {string} name
   * @param {Record<string, unknown>} args
   * @returns {Promise<{ ok: true, text: string, images: { data: string, mimeType: string }[], value: unknown } | { ok: false, text: string, stage: string, detail: string }>}
   */
  async call(name, args) {
    if (this.closed) {
      return { ok: false, text: '这个 Penpot 会话已经关闭了。', stage: 'endpoint', detail: 'session closed' }
    }
    try {
      const result = await this.client.callTool(
        { name, arguments: args ?? {} },
        undefined,
        { timeout: this.toolCallTimeoutMs },
      )
      const blocks = Array.isArray(result?.content) ? result.content : []
      const texts = []
      const images = []
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        else if (block?.type === 'image' && typeof block.data === 'string') {
          images.push({ data: block.data, mimeType: block.mimeType ?? 'image/png' })
        } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
          texts.push(block.resource.text)
        }
      }
      const text = texts.join('\n').trim()
      // Penpot 的失败**不设 isError** —— 它把错误当成正常文本返回，原文形如
      // "Tool execution failed: Error: No Penpot plugin instances are currently connected."
      // 所以这里必须看文本，否则探测会把「插件没连」误判成「已打通」（实测踩过）。
      const failedByText = /^\s*Tool execution failed/i.test(text)
      if (result?.isError === true || failedByText) {
        const graded = classifyFailure(text)
        return { ok: false, text, stage: graded.stage, detail: graded.detail }
      }
      return {
        ok: true,
        text,
        images,
        value: result?.structuredContent ?? undefined,
      }
    } catch (error) {
      const text = errorText(error)
      const graded = classifyFailure(text)
      return { ok: false, text, stage: graded.stage === 'ok' ? 'endpoint' : graded.stage, detail: graded.detail }
    }
  }

  /** 关闭会话（幂等）。 */
  async close() {
    if (this.closed) return
    this.closed = true
    try { await this.client.close() } catch {}
    try { await this.transport?.close?.() } catch {}
  }
}

/**
 * 走 stdio 建连（本地档）。
 *
 * @param {object} options
 * @param {string} options.command
 * @param {string[]} options.args
 * @param {string} [options.cwd]
 * @param {Record<string, string>} [options.env]
 * @param {number} options.connectTimeoutMs
 * @param {number} options.toolCallTimeoutMs
 * @param {string} [options.endpointLabel]
 * @returns {Promise<PenpotSession>}
 */
export async function connectStdio(options) {
  const transport = new StdioClientTransport({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: options.env,
    stderr: 'pipe',
  })
  const client = new Client(CLIENT_INFO, { capabilities: {} })
  await withTimeout(
    client.connect(transport),
    options.connectTimeoutMs,
    `stdio 建连超时（${options.connectTimeoutMs}ms）`,
  )
  const tools = await listToolsOf(client, options.connectTimeoutMs)
  return new PenpotSession({
    client,
    transport,
    transportKind: 'stdio',
    endpoint: options.endpointLabel ?? `${options.command} ${(options.args ?? []).join(' ')}`,
    tools,
    toolCallTimeoutMs: options.toolCallTimeoutMs,
    instructions: typeof client.getInstructions === 'function' ? client.getInstructions() : undefined,
  })
}

/**
 * 走 HTTP（streamable-http，失败可降级 sse）建连（官方 / 自部署 / 本地服务档）。
 *
 * 注意标题里的「本地服务」：Penpot 的本地 MCP 服务器也是**HTTP 服务**
 * （4401），不是 stdio。stdio 只用于「有别的客户端用 stdio 桥包了一层」
 * 这种外部配置（迁移时只会导入其参数，不会真的去起它）。
 *
 * @param {object} options
 * @param {string} options.url 已含 userToken（若需要）
 * @param {'http' | 'sse'} [options.transport]
 * @param {Record<string, string>} [options.headers]
 * @param {boolean} [options.allowInsecureTLS]
 * @param {number} options.connectTimeoutMs
 * @param {number} options.toolCallTimeoutMs
 * @param {string} [options.endpointLabel]
 * @returns {Promise<PenpotSession>}
 */
export async function connectRemote(options) {
  const url = new URL(options.url)
  const requestInit = options.headers === undefined ? undefined : { headers: options.headers }
  const wanted = options.transport === 'sse' ? 'sse' : 'http'

  const build = (kind) => {
    if (kind === 'sse') return new SSEClientTransport(url, { requestInit })
    return new StreamableHTTPClientTransport(url, { requestInit })
  }

  const attempt = async (kind) => {
    const transport = build(kind)
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    try {
      await withTimeout(
        client.connect(transport),
        options.connectTimeoutMs,
        `${kind} 建连超时（${options.connectTimeoutMs}ms）`,
      )
      const tools = await listToolsOf(client, options.connectTimeoutMs)
      return new PenpotSession({
        client,
        transport,
        transportKind: kind,
        endpoint: options.endpointLabel ?? url.origin,
        tools,
        toolCallTimeoutMs: options.toolCallTimeoutMs,
        instructions: typeof client.getInstructions === 'function' ? client.getInstructions() : undefined,
      })
    } catch (error) {
      try { await client.close() } catch {}
      try { await transport.close() } catch {}
      throw error
    }
  }

  try {
    return await attempt(wanted)
  } catch (error) {
    // 主传输失败时降级试另一条：Penpot 两个端点是同一台服务器上的不同路径，
    // 主路径 405/415 而 sse 能用是真实场景（实测 /mcp/sse 可用）。
    if (wanted === 'http' && options.transport !== 'sse') {
      try {
        return await attempt('sse')
      } catch {
        throw error
      }
    }
    throw error
  }
}

async function listToolsOf(client, timeoutMs) {
  const listed = await withTimeout(client.listTools(undefined, { timeout: timeoutMs }), timeoutMs, 'listTools 超时')
  const tools = Array.isArray(listed?.tools) ? listed.tools : []
  return tools.map((tool) => ({
    name: String(tool.name ?? ''),
    description: typeof tool.description === 'string' ? tool.description : undefined,
    inputSchema: tool.inputSchema ?? undefined,
  }))
}

/**
 * 给一个 promise 加超时。
 *
 * 之所以不依赖 AbortSignal：SDK 的 connect 在某些传输上不响应 abort，
 * 超时后继续等会让面板一直转圈。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message) {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
