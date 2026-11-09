/**
 * 服务层：一次「准备好」要干的事，工具、面板、路由三方共用同一套逻辑。
 *
 * 状态机：
 *   idle → starting → running → (degraded) → stopping → idle
 * 其中 running 分 owned（我们起的本地进程）与 adopted（接管已有的）。
 *
 * 两种启动方式的语义在这两层不同，但对外只有一个 `ensureReady()`：
 *   - startup=auto ：插件加载后异步跑一次 ensureReady()，失败不炸、只记状态
 *   - startup=lazy ：首次调用任一 penpot_* 工具、面板按钮、control 工具才跑
 *   两种情况都不用「回合结束就释放」—— 本地进程按需求「唤醒后一直启动」常驻。
 *
 * @module dsh-plugin-penpot/service
 */

import { resolveConfig, resolveTarget } from './config.js'
import { connectRemote, connectStdio, errorText, withToken } from './mcp-client.js'
import {
  recoverOrphan,
  readLogTail,
  resolveLocalLaunch,
  startLocal,
  stopLocal,
  describeLocal,
  drainSession,
} from './runtime.js'
import { maskToken, redactUrl, readOverrides } from './store.js'
import { callCommand, verifyToken, apiBaseOf } from './rest.js'
import { DesignWriter } from './design.js'
import { openDesign, closeDesignBrowser as closeBrowser, browseStatus } from './browser.js'
import { resolvePluginDir, startPluginHost } from './plugin-host.js'

/** 探测四级的名字（面板与 status 工具共用）。 */
export const STAGES = {
  endpoint: '端点可达',
  'no-token': '缺 MCP key',
  'no-instance': 'Penpot 未连上来',
  ok: '已打通',
}

/** PAT 只读通道的探测级（比 MCP 的四级多一条，因为它们测的不是同一件事）。 */
export const PAT_STAGES = {
  endpoint: '端点可达',
  'no-token': '没配令牌',
  'bad-token': '令牌无效',
  blocked: '被网关挡了',
  ok: '凭据有效',
}

/**
 * @param {object} options
 * @param {(message: string) => void} [options.log]
 */
export class PenpotService {
  constructor(options = {}) {
    this.log = options.log ?? (() => {})
    /** @type {ReturnType<typeof resolveConfig>} */
    this.config = resolveConfig({})
    this.session = undefined
    this.state = 'idle'
    this.adopted = false
    this.pid = undefined
    this.endpoint = ''
    this.tools = []
    this.lastError = ''
    this.lastProbe = { at: '', stage: 'endpoint', detail: '' }
    /**
     * PAT / REST 通道的最近一次探测结论。
     *
     * 为什么它要和 MCP 的 lastProbe **分开存**：两条通道能独立地一好一坏。
     * 合在一起就会出现「REST 明明能读写，面板却报已中断」这种谎话。
     */
    this.lastPatProbe = { at: '', stage: 'unchecked', detail: '', label: '' }
    this.startingPromise = undefined
    this.joinedAt = Date.now()
    /** 最近一次真正调用上游的时间（空闲停止用）。 */
    this.lastUsedAt = Date.now()
    this.startCount = 0
    /** 插件 UI 静态服务（本地档 bundled 托管时才有）。 */
    this.pluginHost = undefined
    /** 上一次托管失败的原因（面板要能显示，不然用户不知道为什么连不上）。 */
    this.pluginHostError = ''
  }

  /**
   * 从「部署配置 + 用户覆盖」重算配置。
   *
   * volatile 语义：设置页改完立刻重新 resolve，不需要重启 DSH。
   *
   * @param {Record<string, unknown>} [deploy] patch 行的 config
   */
  refreshConfig(deploy) {
    const merged = resolveConfig(mergeLayers(deploy ?? {}, readOverrides()))
    this.config = merged
    return merged
  }

  /** 当前档位（auto 已解析成具体档）。 */
  effectiveMode() {
    return this.config.mode === 'auto' ? (this.config.detected.picked || 'local') : this.config.mode
  }

  /**
   * 对外配置视图：token 只回「配没配」，URL 把 userToken 打掉。
   */
  publicConfig() {
    const config = this.config
    return {
      mode: config.mode,
      effectiveMode: this.effectiveMode(),
      startup: config.startup,
      requireApproval: config.requireApproval,
      exposeControlTool: config.exposeControlTool,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      connectTimeoutMs: config.connectTimeoutMs,
      idleStopMinutes: config.idleStopMinutes,
      detected: config.detected,
      official: {
        endpoint: redactUrl(config.official.endpoint),
        transport: config.official.transport,
        // key 可能单独存（.token），也可能还留在端点 URL 里 —— 两种都要算「配了」，
        // 否则面板会对着一个明明带 userToken 的地址说「未配置」。
        auth: maskToken(config.official.token !== '' ? config.official.token : this.#keyOf(config.official.endpoint)),
      },
      local: {
        sub: config.local.sub,
        repoDir: config.local.repoDir,
        entry: config.local.entry,
        nodePath: config.local.nodePath,
        npmTag: config.local.npmTag,
        autoBuild: config.local.autoBuild,
        host: config.local.host,
        httpPort: config.local.httpPort,
        wsPort: config.local.wsPort,
        replPort: config.local.replPort,
        logLevel: config.local.logLevel,
        pluginHosting: config.local.pluginHosting,
        env: config.local.env,
      },
      selfhost: {
        url: redactUrl(config.selfhost.url),
        transport: config.selfhost.transport,
        allowInsecureTLS: config.selfhost.allowInsecureTLS,
        auth: maskToken(config.selfhost.token !== '' ? config.selfhost.token : this.#keyOf(config.selfhost.url)),
      },
      pat: {
        reuseMcpKey: config.pat.reuseMcpKey,
        /** 实际会用的那个令牌（脱敏）；不是「单独配的」——面板要看到真实可用状态。 */
        auth: maskToken(this.patToken()),
        /** 令牌来自哪儿：'pat' | 'mcp-key' | ''，面板据此说清改哪个。 */
        from: this.#patSource(),
        apiBase: redactUrl(this.#patBase()),
      },
      browser: {
        autoLaunch: config.browser.autoLaunch,
        path: config.browser.path,
        headless: config.browser.headless,
      },
    }
  }

  /** PAT 实际取自哪里：'pat' | 'mcp-key' | ''（都没有）。 */
  #patSource() {
    const config = this.config
    if (config.pat.token !== '') return 'pat'
    if (config.pat.reuseMcpKey) {
      const key = this.#mcpKey()
      if (key !== '') return 'mcp-key'
    }
    return ''
  }

  /** 从 URL 里取 userToken（取不到返回空串）。 */
  #keyOf(url) {
    if (typeof url !== 'string' || url === '') return ''
    try {
      return new URL(url).searchParams.get('userToken') ?? ''
    } catch {
      const match = /[?&]userToken=([^&]*)/i.exec(url)
      return match === null ? '' : decodeURIComponent(match[1])
    }
  }

  /** 当前档位对应的 MCP key（official/selfhost 端点 URL 里的 userToken）。 */
  #mcpKey() {
    const target = resolveTarget(this.config)
    if (target.kind !== 'local') {
      if (typeof target.token === 'string' && target.token !== '') return target.token
      return this.#keyOf(target.url)
    }
    // 本地档：PAT 通道借的 key 来自远端档（见 #patBase）
    for (const block of [this.config.official, this.config.selfhost]) {
      const url = block.endpoint ?? block.url ?? ''
      if (url === '') continue
      const key = block.token !== '' ? block.token : this.#keyOf(url)
      if (key !== '') return key
    }
    return ''
  }

  /**
   * PAT 通道打哪个基址。
   *
   * 优先用当前档位的远端端点；**本地档时回落到已配置的远端端点** ——
   * 这不矛盾：PAT 走的是 Penpot 的 REST API，和「MCP 连本地还是连云端」无关。
   * 用户在本机跑 MCP 服务器，同时想读自己 design.penpot.app 上的文件，是常见情形。
   *
   * @returns {string} MCP 端点 URL（空串 = 没有可读的远端）
   */
  #patBase() {
    const target = resolveTarget(this.config)
    if (target.kind !== 'local') return target.url
    // 本地档：找哪个远端档既有地址又有凭据
    for (const block of [this.config.official, this.config.selfhost]) {
      const url = block.endpoint ?? block.url ?? ''
      if (url === '') continue
      const key = block.token !== '' ? block.token : this.#keyOf(url)
      if (key !== '') return url
    }
    return ''
  }

  /** PAT 通道的令牌（显式配置优先，否则借 MCP key）。 */
  patToken() {
    const config = this.config
    if (config.pat.token !== '') return config.pat.token
    return config.pat.reuseMcpKey ? this.#mcpKey() : ''
  }

  /**
   * PAT 只读通道能不能用 —— 这只是「配没配」，不发请求。
   *
   * @returns {{ usable: boolean, from: string, apiBase: string }}
   */
  patAvailability() {
    const from = this.#patSource()
    const apiBase = this.#patBase()
    return { usable: from !== '' && apiBase !== '', from, apiBase }
  }

  /**
   * 验凭据（PAT / MCP key）—— MCP 通道做不到的事。
   *
   * MCP 服务端**不校验 key**：随便填个字符串 `initialize` 也返回 200。
   * 只有 REST 通道的 401 才能证明「这个令牌真的无效」。
   *
   * @returns {Promise<{ stage: string, label: string, detail: string, from: string, teamCount?: number }>}
   */
  async probePat() {
    const from = this.#patSource()
    const availability = this.patAvailability()
    if (!availability.usable) {
      const result = {
        stage: 'no-token',
        label: PAT_STAGES['no-token'],
        detail: from === ''
          ? '没有 PAT，且没开「借用 MCP key」—— 面板里贴一个，或把那个开关打开。'
          : 'PAT 只读通道没有可读的远端端点：PAT 走 Penpot 的 REST API，得先在「官方托管」或「自部署」里填好地址和凭据（本机 MCP 服务没有 REST API）。',
        from,
      }
      this.lastPatProbe = { at: new Date().toISOString(), ...result }
      return result
    }
    const target = resolveTarget(this.config)
    const verified = await verifyToken({
      endpoint: availability.apiBase,
      token: this.patToken(),
      allowInsecureTLS: target.allowInsecureTLS === true,
    })
    const result = {
      ...verified,
      label: PAT_STAGES[verified.stage] ?? verified.label,
      from,
    }
    this.lastPatProbe = { at: new Date().toISOString(), ...result }
    return result
  }

  /**
   * 造一个设计稿写通道（不需要 Penpot 标签页）。
   *
   * 为什么不让工具层自己拼：写通道要一整组东西（端点、令牌、超时、自签证书），
   * 散在工具层会重复四行判断，而且容易漏掉「本机档没有 REST API」这条。
   *
   * @returns {DesignWriter}
   */
  designWriter() {
    const availability = this.patAvailability()
    if (!availability.usable) {
      throw new Error(this.#patSource() === ''
        ? '设计稿写通道需要令牌。面板「个人访问令牌」里贴一个，或打开「借用 MCP key」（Integrations 里那个 key 本身就是有效 PAT）。'
        : '设计稿写通道没有可写的远端端点。REST 写只对「官方托管」/「自部署」有意义 —— 本机 MCP 服务没有 REST API。')
    }
    const target = resolveTarget(this.config)
    return new DesignWriter({
      endpoint: availability.apiBase,
      token: this.patToken(),
      timeoutMs: this.config.toolCallTimeoutMs,
      allowInsecureTLS: target.allowInsecureTLS === true,
      log: this.log,
    })
  }

  /**
   * Penpot 站点根地址（浏览器该打开哪儿）。
   *
   * 从当前远端端点推：`https://design.penpot.app/mcp/stream` → `https://design.penpot.app`。
   */
  appUrl() {
    const base = this.#patBase()
    if (base === '') return ''
    return apiBaseOf(base)
  }

  /**
   * 无人值守地打开设计稿（自己起浏览器，不碰用户的默认浏览器）。
   *
   * @param {object} [options]
   * @param {string} [options.fileId]
   */
  async openDesign(options = {}) {
    const appUrl = this.appUrl()
    if (appUrl === '') throw new Error('没有可打开的远端端点：先在「官方托管」或「自部署」里配好地址。')
    const result = await openDesign({
      fileId: options.fileId,
      // 没有 teamId，Penpot 会把 workspace 踢回 dashboard（不报错，只是静默重定向）
      teamId: options.teamId,
      pageId: options.pageId,
      appUrl,
      browserPath: this.config.browser.path,
      headless: this.config.browser.headless,
      timeoutMs: this.config.browser.launchTimeoutMs,
      log: this.log,
    })
    if (result.ok) this.lastBrowserOpen = { at: new Date().toISOString(), ...result }
    return result
  }

  /**
   * 从一个 fileId 反查它属于哪个团队。
   *
   * 为什么需要：打开设计稿必须同时给 `team-id` 和 `file-id`，而用户手上通常
   * 只有一个 fileId（比如从 penpot_read 拿到的）。这里串一次 REST 把它补全，
   * 免得让人自己去翻。
   *
   * @param {string} fileId
   * @returns {Promise<{ teamId: string, projectId: string, pageId: string } | undefined>}
   */
  async locateFile(fileId) {
    if (typeof fileId !== 'string' || fileId === '') return undefined
    try {
      const teams = await this.readPenpot('get-teams')
      for (const team of Array.isArray(teams) ? teams : []) {
        const teamId = team?.id
        if (typeof teamId !== 'string' || teamId === '') continue
        const projects = await this.readPenpot('get-projects', { 'team-id': teamId })
        for (const project of Array.isArray(projects) ? projects : []) {
          const projectId = project?.id
          if (typeof projectId !== 'string' || projectId === '') continue
          const files = await this.readPenpot('get-project-files', { 'project-id': projectId })
          const hit = (Array.isArray(files) ? files : []).find((entry) => entry?.id === fileId)
          if (hit !== undefined) {
            // 页面 id 顺手取第一页：多给一个参数没坏处，Penpot 少了它也能开
            let pageId = ''
            try {
              const pages = await this.pagesOf(fileId)
              pageId = pages[0] ?? ''
            } catch { /* 拿不到就空着 */ }
            return { teamId, projectId, pageId }
          }
        }
      }
    } catch {
      // 反查失败不该挡住「打开」这件事本身
    }
    return undefined
  }

  /** 只取文件的第一页 id（get-file 太大，但这里只需要 pages[0]）。 */
  async pagesOf(fileId) {
    const file = await this.readPenpot('get-file', { id: fileId })
    const pages = file?.data?.pages ?? file?.pages ?? []
    return Array.isArray(pages) ? pages : []
  }

  /** 关掉插件自己起的浏览器（只关自己起的）。 */
  async closeDesignBrowser() {
    return closeBrowser()
  }

  /** 浏览器子系统状态。 */
  async browserStatus() {
    return browseStatus()
  }

  /**
   * 走 REST 通道读一条 Penpot 数据。
   *
   * @param {string} command rest.js 白名单里的命令
   * @param {Record<string, unknown>} [params]
   */
  async readPenpot(command, params = {}) {
    const availability = this.patAvailability()
    if (!availability.usable) {
      throw new Error(this.#patSource() === ''
        ? 'PAT 只读通道没配令牌。面板「个人访问令牌」里贴一个，或打开「借用 MCP key」（Integrations 里那个 key 本身就是有效 PAT）。'
        : 'PAT 只读通道没有可读的远端端点。PAT 走的是 Penpot 的 REST API，需要先在「官方托管」或「自部署」里填好地址和凭据（本机 MCP 服务没有 REST API）。')
    }
    const target = resolveTarget(this.config)
    const result = await callCommand({
      endpoint: availability.apiBase,
      token: this.patToken(),
      command,
      params,
      timeoutMs: this.config.connectTimeoutMs,
      allowInsecureTLS: target.allowInsecureTLS === true,
    })
    // 错误文本里带上机器可读的 code：调用方（工具层 / 测试）不该靠中文去判断
    if (!result.ok) throw new Error(`[PAT ${result.code}] ${result.message}`)
    return result.data
  }

  /** 轻量状态（面板每次轮询都读，不能碰进程）。 */
  snapshot() {
    const target = resolveTarget(this.config)
    return {
      // 面板看到的「状态」以探测结论为准，别对着一个连不上设计稿的链路亮绿灯
      state: this.#displayState(),
      mode: this.effectiveMode(),
      startup: this.config.startup,
      adopted: this.adopted,
      pid: this.pid,
      endpoint: redactUrl(this.endpoint || target.url || ''),
      transportKind: this.session?.transportKind ?? '',
      widgetOnly: false,
      tools: this.tools,
      toolCount: this.tools.length,
      lastError: this.lastError,
      lastProbe: this.lastProbe,
      stages: STAGES,
      /** 两条通道各自的状态 —— 面板分开展示，不再用一个 dot 概括。 */
      channels: this.channels(),
      /** REST 通道最近一次自检（不需要 MCP 服务就能有值）。 */
      lastPatProbe: this.lastPatProbe,
      uptimeMs: this.state === 'running' ? Date.now() - this.joinedAt : 0,
      idleMs: Date.now() - this.lastUsedAt,
      startCount: this.startCount,
      hasSession: this.session !== undefined && this.session.closed !== true,
    }
  }

  /** 面板「诊断」区：本地进程细节 + 日志尾部。 */
  async diagnostics() {
    const target = resolveTarget(this.config)
    const local = target.kind === 'local' ? await describeLocal({ config: this.config, runtime: { adopted: this.adopted, pid: this.pid } }) : undefined
    return {
      target,
      local,
      logTail: target.kind === 'local' ? readLogTail(80) : '',
      evaluatedAt: new Date().toISOString(),
    }
  }

  /**
   * 确保「能用」：建连（必要时先拉起本地进程）。并发调用共享同一次启动。
   *
   * @param {{ force?: boolean }} [options]
   * @returns {Promise<{ ok: true, adopted: boolean, tools: string[] } | { ok: false, error: string, stage: string, hint?: string }>}
   */
  async ensureReady(options = {}) {
    if (options.force !== true && this.session !== undefined && this.session.closed !== true) {
      return { ok: true, adopted: this.adopted, tools: this.tools }
    }
    if (this.startingPromise !== undefined) return this.startingPromise
    this.startingPromise = this.#start().finally(() => { this.startingPromise = undefined })
    return this.startingPromise
  }

  async #start() {
    const target = resolveTarget(this.config)
    this.state = 'starting'
    this.lastError = ''
    this.startCount++
    try {
      if (target.kind === 'local') {
        // 优先接管上次留下的实例（DSH 重启后不用再等一次冷启动）
        const orphan = await recoverOrphan({ config: this.config, log: this.log }).catch(() => undefined)
        if (orphan === undefined) {
          const started = await startLocal({ config: this.config, log: this.log })
          if (!started.ok) {
            this.state = 'degraded'
            this.lastError = started.error
            this.adopted = false
            return {
              ok: false,
              error: started.error,
              stage: 'endpoint',
              ...(started.hint === undefined ? {} : { hint: started.hint }),
            }
          }
          this.adopted = started.adopted
          this.pid = started.pid
        } else {
          this.adopted = true
          this.pid = orphan.pid
        }
        // 顺手把插件 UI 托管起来：Penpot 标签页要加载它才谈得上「连上来」。
        // 失败不阻断 MCP 连接 —— 用户可能已经用别的方式托管了。
        await this.#ensurePluginHost()
        // 本地是 stdio？不 —— Penpot 的本地服务器是 HTTP 服务，走 http 连。
        const session = await connectRemote({
          url: target.url,
          transport: 'http',
          connectTimeoutMs: this.config.connectTimeoutMs,
          toolCallTimeoutMs: this.config.toolCallTimeoutMs,
          endpointLabel: target.url,
        })
        return this.#accept(session, target.kind)
      }

      // 远端（official / selfhost）：token 只能拼进 URL
      const url = withToken(target.url, target.token)
      const session = await connectRemote({
        url,
        transport: target.transport,
        allowInsecureTLS: target.allowInsecureTLS,
        connectTimeoutMs: this.config.connectTimeoutMs,
        toolCallTimeoutMs: this.config.toolCallTimeoutMs,
        endpointLabel: redactUrl(target.url),
      })
      this.adopted = false
      this.pid = undefined
      return this.#accept(session, target.kind)
    } catch (error) {
      this.state = 'degraded'
      const text = errorText(error)
      this.lastError = text
      this.lastProbe = { at: new Date().toISOString(), stage: 'endpoint', detail: text.slice(0, 300) }
      return { ok: false, error: text, stage: 'endpoint', hint: hintFor(target, text) }
    }
  }

  /**
   * 确保插件 UI 静态托管就绪（本地档专用）。
   *
   * 为什么在服务层：Penpot 的连接是两段的（浏览器加载插件 UI → 插件连本机 MCP），
   * 只有第二段是我们的 MCP 服务器管的。第一段没人做的话，用户在 Penpot 里
   * 根本无从「点 Connect」，而这不是他能自己想到要修的事。
   *
   * 失败**不抛**：用户可能已经用 `pnpm run bootstrap` 或自己的 nginx 托管着，
   * 插件不该因此拒绝连接 MCP。
   *
   * @returns {Promise<{ hosting: string, url: string, ok: boolean, reason?: string }>}
   */
  async #ensurePluginHost() {
    const local = this.config.local
    const hosting = local.pluginHosting
    if (hosting === 'external') {
      this.pluginHost = undefined
      return { hosting, url: '', ok: true, reason: '由你自己托管，插件只显示该填的 URL' }
    }
    if (hosting === 'port') {
      this.pluginHost = undefined
      return { hosting, url: `http://localhost:${local.pluginPort}/manifest.json`, ok: true, reason: '交给 MCP 服务器的 4400（官方 bootstrap）' }
    }
    // bundled：自己起。已经起着就复用。
    if (this.pluginHost !== undefined) {
      return { hosting, url: this.pluginHost.url, ok: true }
    }
    const located = resolvePluginDir({ repoDir: local.repoDir })
    if (located.ok !== true) {
      this.pluginHostError = located.reason
      this.log(`插件 UI 托管跳过：${located.reason}`)
      return { hosting, url: '', ok: false, reason: located.reason }
    }
    const started = await startPluginHost({
      dir: located.dir,
      host: local.host,
      port: local.pluginPort,
      log: this.log,
    })
    if (started.ok !== true) {
      this.pluginHostError = started.reason
      this.log(`插件 UI 托管失败：${started.reason}`)
      return { hosting, url: '', ok: false, reason: started.reason }
    }
    this.pluginHost = started
    this.pluginHostError = ''
    return { hosting, url: started.url, ok: true }
  }

  /**
   * 插件 UI 托管状态（面板与 status 工具读它；不改任何状态）。
   *
   * @returns {{ hosting: string, url: string, running: boolean, ws: string, reason: string }}
   */
  pluginHostInfo() {
    const local = this.config.local
    const hosting = local.pluginHosting
    if (hosting === 'port') {
      return {
        hosting,
        url: `http://localhost:${local.pluginPort}/manifest.json`,
        running: this.state === 'running',
        ws: `ws://${local.host}:${local.wsPort}`,
        reason: '交给 MCP 服务器的 4400（官方 pnpm run bootstrap 那套）',
      }
    }
    if (hosting === 'external') {
      return {
        hosting,
        url: '',
        running: false,
        ws: `ws://${local.host}:${local.wsPort}`,
        reason: '由你自己托管：在 Penpot → 插件 → 从 URL 载入 里填你自己的 manifest.json 地址',
      }
    }
    return {
      hosting,
      url: this.pluginHost?.url ?? '',
      running: this.pluginHost !== undefined,
      adopted: this.pluginHost?.adopted === true,
      ws: `ws://${local.host}:${local.wsPort}`,
      reason: this.pluginHost !== undefined
        ? (this.pluginHost.adopted === true
          ? '端口上已经有一个同样的插件 UI，直接接管（不是本插件起的，停服务时不会去关它）'
          : '插件自己起的静态服务（停服务时一起停）')
        : (this.pluginHostError || '还没起来：调 start 或等到首次建连'),
    }
  }

  /** 停掉插件 UI 静态服务（stop/restart 时调）。 */
  async #stopPluginHost() {
    if (this.pluginHost === undefined) return
    const host = this.pluginHost
    this.pluginHost = undefined
    try {
      await host.close()
    } catch (error) {
      this.log(`插件 UI 服务关闭出错：${String(error?.message ?? error)}`)
    }
  }

  #accept(session, kind) {
    this.session = session
    this.tools = session.toolNames()
    this.endpoint = session.endpoint
    this.state = 'running'
    this.joinedAt = Date.now()
    this.lastUsedAt = Date.now()
    this.log(`ready: ${kind} ${session.endpoint} tools=${this.tools.length}`)
    // 建连成功 ≠ 打通：再加一级 execute_code 探测（远端尤其重要）
    return { ok: true, adopted: this.adopted, tools: this.tools }
  }

  /**
   * 四级探测 —— 面板「测试连接」与 penpot_status 共用。
   *
   * 为什么要四级：Penpot 没有 OAuth，服务端不校验 key 本身，只能靠
   * execute_code 的报错文本判断到底停在哪一步（见 README「鉴权真相」）。
   *
   * @returns {Promise<{ stage: 'endpoint' | 'no-token' | 'no-instance' | 'ok', label: string, detail: string, toolCount: number }>}
   */
  async probe() {
    const ready = await this.ensureReady()
    if (!ready.ok) {
      return {
        stage: 'endpoint',
        label: STAGES.endpoint,
        detail: ready.error,
        toolCount: 0,
      }
    }
    if (!this.tools.includes('execute_code')) {
      const result = { stage: 'endpoint', label: STAGES.endpoint, detail: '端点通了，但工具集里没有 execute_code —— 对面可能不是 penpot MCP。', toolCount: this.tools.length }
      this.lastProbe = { at: new Date().toISOString(), ...result }
      return result
    }
    // 用一个绝对安全的只读表达式探测，不会改用户的设计稿
    const outcome = await this.session.call('execute_code', { code: 'return 1 + 1' })
    const stage = outcome.ok ? 'ok' : (outcome.stage ?? 'endpoint')
    const label = STAGES[stage] ?? STAGES.endpoint
    let detail = outcome.ok
      ? 'execute_code 返回了结果，链路完整。'
      : (outcome.detail ?? outcome.text ?? '')
    // 停在 no-instance 时，MCP 通道自己分不清「key 错了」和「标签页没连」——
    // 它不校验 key。这时借 PAT 通道读一次（不需要标签页）就能把两者分开，
    // 从而告诉用户到底该去查哪一边。
    let credentialProven = false
    if (stage === 'no-instance' && this.patAvailability().usable) {
      const verified = await this.probePat()
      if (verified.stage === 'ok') {
        credentialProven = true
        detail += `\n但凭据本身有效（${verified.detail}）—— 所以 key 没问题，是 Penpot 标签页没连上来。`
      } else if (verified.stage === 'bad-token') {
        detail += '\n而且凭据被 REST 判为无效 —— key 可能已过期或填错了，去 Integrations 重新生成。'
      }
    }
    // 本地档停在 no-instance：多半是插件 UI 没在 Penpot 里加载过。直接把该填的地址给出来。
    if (stage === 'no-instance' && this.effectiveMode() === 'local') {
      const host = this.pluginHostInfo()
      if (host.hosting === 'bundled' && host.url !== '') {
        detail += `\n在 Penpot 里：插件 → 从 URL 载入 → ${host.url}，然后点 Connect MCP Server。`
      } else if (host.reason !== '') {
        detail += `\n插件 UI 托管：${host.reason}`
      }
    }
    // 停在 no-token（远端档）：没有 MCP key，但 PAT 通道可能照样能用（REST 认 Token 头）
    if (stage === 'no-token' && this.patAvailability().usable) {
      detail += '\nMCP 通道没 key；但 PAT 只读通道可用，penpot_read 仍能读设计数据。'
    }
    // 本机档连不上时提醒一句：如果官方端点已经配了凭据，很可能 Penpot 里连的是官方那条。
    // 自动判定只看得懂「端口有没有人在听」，看不懂「哪个端点上有 Penpot 标签页」——
    // 本地服务器起着、但 Penpot 连的是官方，是很常见的组合，不说清楚会让人去查错东西。
    if (stage === 'no-instance' && this.effectiveMode() === 'local') {
      const officialKey = this.config.official.token !== '' ? this.config.official.token : this.#keyOf(this.config.official.endpoint)
      if (officialKey !== '') {
        detail += '\n提示：官方端点的凭据也配着。如果你在 Penpot 里连的是官方 MCP（File → MCP 服务器 → 已连接），'
          + '把档位改成「官方托管」就行，不用管这个本地服务。'
      }
    }
    const result = { stage, label, detail, toolCount: this.tools.length, credentialProven }
    this.lastProbe = { at: new Date().toISOString(), ...result }
    // `this.state` 只记 **MCP 通道自己的**结论，不要在这里揉进「能不能干活」。
    // 能不能干活要看两条通道（见 #displayState）—— 早期版本在这里就把
    // no-instance 打成 waiting/degraded，等于默认「只有 MCP 算能用」，
    // 于是 REST 明明读写都通、面板却报「已中断」。
    this.state = outcome.ok ? 'running' : 'degraded'
    return result
  }

  /**
   * 面板看到的状态。
   *
   * ## 为什么不能只看 MCP
   *
   * 最早这里只有「MCP 握手成功 = running」，后来又凭「标签页开没开」把
   * `no-instance` 打成 `waiting`（黄）或 `degraded`（红）。这个判断是**错的**，
   * 因为它默认「只有 MCP 通道算能用」—— 而实际上 REST 通道（PAT / MCP key
   * 走 `Authorization: Token`）**不需要标签页**就能读、能写、能建文件。
   *
   * 所以一个「Penpot 没打开」但 PAT 有效的插件，功能其实完好：
   * `penpot_read` / `penpot_write` 全都能用。把它标成红色「已中断」是在撒谎，
   * 用户会去查错东西。
   *
   * 现在的判据是**两条通道各自独立**，再看合起来能不能干活：
   *
   * | MCP | REST | state | 含义 |
   * |---|---|---|---|
   * | ✅ | 任意 | `running` | 全功能 |
   * | ❌ | ✅ | `rest` | 可用，但只能用不需要标签页的那部分（读写设计稿够用） |
   * | ❌ | 未验证 | `waiting` | 可能只是标签页没开；去开一下或验一下令牌 |
   * | ❌ | ❌ | `degraded` | 真出事了 |
   *
   * @returns {string}
   */
  #displayState() {
    const stage = this.lastProbe?.stage
    const mcpOk = this.state === 'running' && stage !== 'no-instance'
    if (mcpOk) return this.state
    if (this.state === 'starting' || this.state === 'stopping' || this.state === 'idle') {
      // 还没连过 MCP，但 REST 通道已经验通了 —— 照样算可用，只是没开 MCP
      if (this.state === 'idle' && this.#restUsable()) return 'rest'
      return this.state
    }
    // MCP 没打通。REST 能干活就不算故障。
    if (this.#restUsable()) return 'rest'
    // 没配任何远端凭据 → REST 也没有 → 真出事了
    if (!this.patAvailability().usable) return 'degraded'
    if (stage === 'no-instance') {
      // 令牌配了但没验过：可能只是没开标签页，如实标「待确认」而不是「已中断」
      return 'waiting'
    }
    return 'degraded'
  }

  /** REST 通道是否已验证可用（`probePat` 说凭据有效）。 */
  #restUsable() {
    return this.lastPatProbe?.stage === 'ok'
  }

  /**
   * 自动检测两条通道 —— **不管 MCP 服务开没开**。
   *
   * ## 为什么必须独立于「服务开没开」
   *
   * 之前的面板状态是「MCP 连上了吗」的副产品：`startup: lazy` 下没调用过工具，
   * 状态就一直停在「未启动」，既不知道 PAT 行不行，也不知道端点通不通。
   * 可 REST 通道**根本不需要 MCP 服务** —— 它就是一个带 Token 头的 HTTP POST。
   * 让它跟着 MCP 的启停走，等于把一半功能藏起来。
   *
   * 所以这里做成一个独立的自检：
   *   - 只验 REST 通道（发 `get-teams`，一个请求就够）
   *   - 不建 MCP 连接、不拉本地进程、不改 `state`
   *   - 每条结果都记在 `lastPatProbe` 上，面板与 `penpot_status` 直接读它
   *
   * @param {{ force?: boolean, maxAgeMs?: number }} [options]
   * @returns {Promise<object>} 与 probePat 相同，额外带 `skipped`
   */
  async autoCheck(options = {}) {
    const maxAgeMs = options.maxAgeMs ?? 30_000
    const last = this.lastPatProbe
    if (options.force !== true && last?.at !== '' && last?.stage !== 'unchecked') {
      const age = Date.now() - Date.parse(last.at)
      // 刚验过就复用结论，别每次轮询都打一次远端
      if (Number.isFinite(age) && age >= 0 && age < maxAgeMs) {
        return { ...last, skipped: true }
      }
    }
    if (!this.patAvailability().usable) {
      // 没配凭据：明确记成「没配」，而不是留着旧结论骗人
      const result = {
        stage: 'no-token',
        label: PAT_STAGES['no-token'],
        detail: '还没有可用的令牌。面板「凭据」里贴一个 PAT，或打开「借用 MCP key」。',
        from: this.patAvailability().from,
      }
      this.lastPatProbe = { at: new Date().toISOString(), ...result }
      return { ...result, skipped: false }
    }
    try {
      const result = await this.probePat()
      return { ...result, skipped: false }
    } catch (error) {
      // 自动检测失败不该炸掉宿主：记下来，面板照常显示
      const result = {
        stage: 'endpoint',
        label: PAT_STAGES.endpoint,
        detail: `自检失败：${String(error?.message ?? error)}`,
        from: this.patAvailability().from,
      }
      this.lastPatProbe = { at: new Date().toISOString(), ...result }
      return { ...result, skipped: false }
    }
  }

  /**
   * 两条通道各自的明细 —— 面板分开显示，不再让一个状态概括两件事。
   *
   * @returns {{ mcp: object, rest: object }}
   */
  channels() {
    const mcpStage = this.lastProbe?.stage ?? 'endpoint'
    return {
      mcp: {
        usable: this.state === 'running' && mcpStage !== 'no-instance',
        stage: mcpStage,
        label: STAGES[mcpStage] ?? STAGES.endpoint,
        detail: this.lastProbe?.detail ?? '',
        // 只有 MCP 需要标签页 —— 这条要说在明面上
        needsTab: true,
        toolCount: this.tools.length,
        endpoint: redactUrl(this.endpoint || resolveTarget(this.config).url || ''),
        checkedAt: this.lastProbe?.at ?? '',
      },
      rest: {
        usable: this.#restUsable(),
        stage: this.lastPatProbe?.stage ?? 'unchecked',
        label: this.lastPatProbe?.stage === 'ok' ? '凭据有效' : (PAT_STAGES[this.lastPatProbe?.stage] ?? '还没验'),
        detail: this.lastPatProbe?.detail ?? '',
        needsTab: false,
        configured: this.patAvailability().usable,
        from: this.patAvailability().from,
        apiBase: this.patAvailability().apiBase,
        checkedAt: this.lastPatProbe?.at ?? '',
      },
    }
  }

  /**
   * 调一个上游工具（工具层用）。
   *
   * @param {string} name
   * @param {Record<string, unknown>} args
   */
  async callTool(name, args) {
    const ready = await this.ensureReady()
    if (!ready.ok) {
      throw new Error(`${ready.error}${ready.hint === undefined ? '' : `\n${ready.hint}`}`)
    }
    if (!this.tools.includes(name)) {
      throw new Error(`当前连接（${this.effectiveMode()}）没有 ${name} 这个工具。可用：${this.tools.join(', ')}`)
    }
    this.lastUsedAt = Date.now()
    const outcome = await this.session.call(name, args)
    if (!outcome.ok) {
      const stage = STAGES[outcome.stage] ?? ''
      throw new Error(`${stage === '' ? '' : `[${stage}] `}${outcome.text || outcome.detail || '上游调用失败'}`)
    }
    return outcome
  }

  /** 断开（不杀本地进程；杀进程是 stop()）。 */
  async disconnect() {
    const session = this.session
    this.session = undefined
    this.tools = []
    if (session !== undefined) await drainSession(session)
    this.state = 'idle'
  }

  /** 停止服务：本地档连进程一起停。 */
  async stop() {
    this.state = 'stopping'
    await this.disconnect()
    await this.#stopPluginHost()
    if (this.effectiveMode() === 'local') {
      const result = await stopLocal({ log: this.log }).catch((error) => ({ ok: false, stopped: false, reason: errorText(error) }))
      this.pid = undefined
      this.adopted = false
      this.state = 'idle'
      return result
    }
    this.state = 'idle'
    return { ok: true, stopped: true, reason: '远端连接已断开（没有本地进程）' }
  }
  /** 重启：先停再起。 */
  async restart() {
    await this.stop()
    return this.ensureReady({ force: true })
  }

  /** 日志尾部（本地档）。 */
  logs(lines = 160) {
    return readLogTail(lines)
  }

  /** 本地入口是否存在（面板显示「要不要先构建」）。 */
  localLaunch() {
    try {
      return resolveLocalLaunch(this.config)
    } catch {
      return undefined
    }
  }
}

/** 把两层配置深合并后交给 resolveConfig。 */
function mergeLayers(deploy, overrides) {
  const out = { ...deploy }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)
      && out[key] !== null && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeLayers(out[key], value)
    } else out[key] = value
  }
  return out
}

/** 失败时给一句能动手的建议。 */
function hintFor(target, text) {
  const value = String(text ?? '')
  if (/ECONNREFUSED|ENOTFOUND|fetch failed|NetworkError/i.test(value)) {
    return target.kind === 'local'
      ? '本地端口没有服务：确认 dist 已构建，或把「子选项」改成 npx。'
      : '连不上远端端点：检查 URL / 网络 / 反向代理。'
  }
  if (/401|403|Unauthorized/i.test(value)) {
    return '远端拒绝了：检查 URL 里的 userToken（Penpot 只认查询参数，不认 Authorization 头）。'
  }
  if (/ENOENT/i.test(value)) {
    return '找不到可执行文件或入口：检查 nodePath 与 repoDir/entry。'
  }
  return undefined
}

export { connectStdio }
