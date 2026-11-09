/**
 * 客户端半边：插件页卡片 + 侧栏页。
 *
 * DSH 用 `window.__ModuleLoader__.load({ id, factory })` 装这类经典脚本，
 * 然后调 `exports.apply(ctx)`。`require` 只能拿到 `react` 与 `react/jsx-runtime` ——
 * 所以这里不 import 任何宿主组件，全部用原生元素画。
 *
 * 视觉上跟宿主一致靠 CSS 变量（`--dsw-alias-*`），不写死颜色。
 *
 * 两个面：
 *   1. `plugins.bundle.config` 槽 —— 侧边栏「插件」→ 本插件那一页的配置卡片。
 *      这个槽只按 `view: 'page'` 派发、没有 summary 折叠变体，所以卡片天然
 *      就是**完整展开**的（符合"插件页可见、默认展开"的要求）。
 *   2. `ctx.betterSidebar.registerTab` —— 装了 dsh-better-sidebar 时多一个
 *      「Penpot」侧栏页，能在工作区里直接看状态、跑探测。
 *      没装就跳过，**不能让等一个可选服务把整棵客户端树卡住**。
 *
 * @module dsh-plugin-penpot/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-penpot',
  factory: require => {
    'use strict'
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const jsx = require('react/jsx-runtime')
    const h = React.createElement

    const API = '/api/penpot'

    /** 写请求的 CSRF 标记头：别的站点构造不出来，等于挡住跨源表单提交。 */
    const WRITE_HEADER = 'x-dsh-penpot'

    /** 版本从 package.json 抄一份；面板显示用，不影响行为。 */
    const VERSION = '0.6.0'

    /**
     * 后端回显的端点里 token 被换成了 `***`（`redactUrl`）。
     *
     * **绝不能把这个占位符填进可编辑输入框**：用户点一下「保存」就会把
     * `userToken=***` 写回磁盘，当场覆盖掉真凭据（实测踩过）。所以初始化
     * 表单时先把 `userToken` 摘掉 —— 凭据在下面单独一行只显示「配没配」。
     *
     * @param {string | undefined} url
     * @returns {string}
     */
    function cleanEndpoint(url) {
      if (typeof url !== 'string' || url === '') return ''
      try {
        const parsed = new URL(url)
        parsed.searchParams.delete('userToken')
        return parsed.toString()
      } catch {
        return url.replace(/([?&])userToken=[^&]*/i, '').replace(/[?&]$/, '')
      }
    }

    // ── 文案 ────────────────────────────────────────────────────────────────
    const TEXTS = {
      zh: {
        title: 'Penpot',
        state_idle: '未启动',
        state_starting: '正在启动…',
        state_running: '运行中',
        state_rest: '可用（REST 通道）',
        state_waiting: '待确认',
        state_degraded: '已中断',
        state_stopping: '正在停止…',
        tabStatus: '概览',
        tabConnection: '连接',
        tabAutomation: '自动化',
        tabMigrate: '迁移',
        tabAdvanced: '高级',
        chanMcpDesc: '在设计稿标签页里跑插件代码。能读当前选中、调用任意 Plugin API —— 但它必须有一个 Penpot 标签页在线。',
        chanRestDesc: '带 Token 头的 HTTP 请求。读写设计稿（建文件、加图层、改属性）都不需要标签页，自动化走这条。',
        chanNeedsTab: '需要有一个 Penpot 标签页在线',
        chanNoTab: '不需要标签页',
        chanOk: '可用',
        chanUnchecked: '还没验',
        chanNoToken: '没配令牌',
        chanBadToken: '令牌无效',
        chanBlocked: '被网关挡了',
        connMode: '连到哪个 Penpot',
        applyDetected: '采用这个结果',
        patToken: '令牌',
        pasteToken: '粘贴令牌（留空 = 不改）',
        selfhostInsecure: '允许自签证书',
        exposeControlLabel: '注册 penpot_control（start / stop / probe / detect / logs / 打开设计稿）',
        autoRestTitle: '不需要浏览器就能做的事',
        autoRestHint: '读团队 / 项目 / 页面结构；建文件、加页面、加图层、改属性、删图层、改名、复制、删除。',
        browserPathPlaceholder: '自动找 Chrome / Edge / Brave',
        browserNotRunning: '没在跑',
        openFileId: '要打开的设计稿 id',
        openTeamId: '团队 id',
        openTeamIdHint: '留空会自动反查。查不到的话 Penpot 会打开 dashboard 而不是设计稿。',
        openFileIdHint: '留空打开首页。id 从 penpot_read what=projectFiles 拿。',
        show: '查看',
        redetect: '重新自动识别',
        skip: '（跳过）',
        nothingSelected: '没有勾选任何条目。',
        connectMsHint: '本地冷启动一次要十几秒，别调太小。',
        mode: '连接目标',
        modeAuto: '自动识别',
        modeOfficial: '官方托管',
        modeLocal: '本地自构建',
        modeSelfhost: '自部署',
        autoHint: '扫描本机已有的 penpot MCP 配置（DSH / Codex / Claude / Cursor / Gemini / 项目级），用扫到的那条。',
        detectedFrom: '当前档位来自',
        startup: '启动方式',
        startupAuto: '加载即启动',
        startupLazy: '首次调用才启动（之后常驻）',
        probe: '测试连接',
        probing: '正在探测…',
        start: '启动',
        stop: '停止',
        restart: '重启',
        save: '保存',
        saving: '正在保存…',
        saved: '已保存',
        endpoint: '端点',
        tools: '上游工具',
        pid: '进程',
        adopted: '接管已有实例',
        stage_endpoint: '端点可达',
        stageNoToken: '缺 MCP key',
        stageNoInstance: 'Penpot 未连上来',
        stage_ok: '已打通',
        officialEndpoint: '端点地址',
        officialToken: 'MCP key',
        tokenConfigured: '已配置（不回显）',
        tokenEmpty: '未配置',
        pasteUrl: '粘贴完整地址',
        pasteUrlHint: '从 Penpot Integrations 复制的地址整串贴进来（含 userToken），保存时自动拆出 key。',
        pat: '个人访问令牌',
        patHint: 'Penpot → 账户 → Integrations。走 REST 通道，不需要标签页；也能离线验证凭据是否有效。',
        patReuse: '借用 MCP key',
        patReuseHint: '那个 MCP key 本身就是有效 PAT —— 开了就不必再单独建令牌。',
        patSource: '当前令牌来源',
        patFromPat: '面板里配的 PAT',
        patFromMcpKey: '借用的 MCP key',
        patFromNone: '没有令牌可用',
        patVerify: '验证凭据',
        localSub: '来源',
        localSubRepo: '现有仓库构建产物',
        localSubNpm: '官方 npm 包（npx）',
        repoDir: '仓库目录',
        entry: '入口文件',
        npmTag: 'npm 标签 / 版本',
        nodePath: 'node 可执行文件',
        nodePathHint: '留空自动使用 DSH 自带的 node。',
        httpPort: 'HTTP',
        wsPort: 'WebSocket',
        replPort: 'REPL',
        pluginHosting: 'Penpot 插件 UI',
        hostingDsh: '插件自己起（推荐）',
        hostingPort: '交给 MCP 服务器的 4400',
        hostingExternal: '我自己托管',
        manifest: '插件 manifest 地址',
        pluginPort: '插件 UI 端口',
        pluginPortHint: '插件自己起一个静态服务来发 manifest.json 与 plugin.js，默认 4400（官方同款）。',
        browser: '无人值守浏览器',
        browserHint: '没人开网页时，插件自己起一个浏览器打开设计稿。独立 profile，不碰你的默认浏览器。',
        browserAuto: '允许插件自己起浏览器',
        browserAutoHint: '默认关 —— 这相当于替你开一个程序。penpot_write 不需要它。',
        browserPath: '浏览器路径',
        browserPathHint: '留空自动找。只有 Chromium 系能驱动 —— Zen 是 Firefox 内核，没有调试协议。',
        browserHeadless: '无头模式',
        browserHeadlessHint: '首次登录必须关掉，不然看不到登录框。',
        browserStatus: '浏览器状态',
        browserOpen: '打开设计稿',
        browserClose: '关掉浏览器',
        browserNotAvailable: '没找到可驱动的浏览器',
        selfhostUrl: '服务器地址',
        selfhostHint: '自己实例里 Integrations → MCP Server 复制的地址，形如 https://你的域名/mcp/stream?userToken=…',
        toolsOn: '当前可用的上游工具',
        approval: '改稿前先问我（execute_code / penpot_write）',
        approvalHint: '这几个工具会改东西：execute_code 在你打开的稿子里跑 JS，penpot_write 增删改图层。关掉后不再每次确认。',
        migrateHint: '扫描本机已有的 penpot 条目。「导入并停用」会先备份，可还原。',
        scan: '扫描',
        scanning: '正在扫描…',
        apply: '应用',
        importOnly: '只导入',
        importDisable: '导入并停用',
        exportSnippet: '只导出片段',
        none: '无',
        logs: '日志',
        refresh: '刷新',
        error: '错误',
        ok: '正常',
        noCandidates: '没扫到 penpot 条目。',
        sidebarTitle: 'Penpot',
        sidebarEmpty: '还没连上。点「启动」或在 Penpot 里点 Connect。',
        timeoutMs: '调用超时（秒）',
        connectMs: '建连超时（秒）',
        idleStop: '空闲停止（分钟，0 = 不停）',
      },
      en: {
        title: 'Penpot',
        state_idle: 'Not started',
        state_starting: 'Starting…',
        state_running: 'Running',
        state_rest: 'Usable (REST)',
        state_waiting: 'Unconfirmed',
        state_degraded: 'Interrupted',
        state_stopping: 'Stopping…',
        tabStatus: 'Overview',
        tabConnection: 'Connection',
        tabAutomation: 'Automation',
        tabMigrate: 'Migration',
        tabAdvanced: 'Advanced',
        chanMcpDesc: 'Runs plugin code inside the design tab. Reads the current selection and any Plugin API call — but it needs a live Penpot tab.',
        chanRestDesc: 'HTTP requests with a Token header. Reading and writing designs (create files, add shapes, change properties) needs no tab; automation uses this.',
        chanNeedsTab: 'Needs a live Penpot tab',
        chanNoTab: 'No tab needed',
        chanOk: 'Usable',
        chanUnchecked: 'Not checked',
        chanNoToken: 'No token',
        chanBadToken: 'Invalid token',
        chanBlocked: 'Blocked by gateway',
        connMode: 'Which Penpot to connect to',
        applyDetected: 'Use this result',
        patToken: 'Token',
        pasteToken: 'Paste a token (empty = leave unchanged)',
        selfhostInsecure: 'Allow self-signed certificate',
        exposeControlLabel: 'Register penpot_control (start / stop / probe / detect / logs / open design)',
        autoRestTitle: 'What works without a browser',
        autoRestHint: 'Read teams / projects / page structure; create files, add pages and shapes, change properties, delete, rename, duplicate.',
        browserPathPlaceholder: 'auto-detect Chrome / Edge / Brave',
        browserNotRunning: 'not running',
        openFileId: 'Design file id to open',
        openTeamId: 'Team id',
        openTeamIdHint: 'Empty = look it up automatically. Without it Penpot opens the dashboard instead of the design.',
        openFileIdHint: 'Empty opens the home page. Get an id from penpot_read what=projectFiles.',
        show: 'Show',
        redetect: 'Re-detect',
        skip: '(skip)',
        nothingSelected: 'Nothing selected.',
        connectMsHint: 'A cold local start takes tens of seconds; do not set this too low.',
        mode: 'Connection target',
        modeAuto: 'Auto-detect',
        modeOfficial: 'Official hosted',
        modeLocal: 'Local build',
        modeSelfhost: 'Self-hosted',
        autoHint: 'Scans the penpot MCP entries you already have (DSH / Codex / Claude / Cursor / Gemini / project) and adopts one.',
        detectedFrom: 'Current target came from',
        startup: 'Startup',
        startupAuto: 'Start on load',
        startupLazy: 'Start on first call (then stay up)',
        probe: 'Test connection',
        probing: 'Probing…',
        start: 'Start',
        stop: 'Stop',
        restart: 'Restart',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        endpoint: 'Endpoint',
        tools: 'Upstream tools',
        pid: 'Process',
        adopted: 'adopted existing',
        stage_endpoint: 'Endpoint reachable',
        stageNoToken: 'Missing MCP key',
        stageNoInstance: 'Penpot not connected',
        stage_ok: 'Working',
        officialEndpoint: 'Endpoint URL',
        officialToken: 'MCP key',
        tokenConfigured: 'configured (hidden)',
        tokenEmpty: 'not configured',
        pasteUrl: 'Paste full URL',
        pasteUrlHint: 'Paste the whole URL from Penpot Integrations (with userToken); the key is extracted on save.',
        pat: 'Personal access token',
        patHint: 'Penpot → Account → Integrations. Uses REST, so no tab is needed; it also verifies the credential offline.',
        patReuse: 'Reuse the MCP key',
        patReuseHint: 'That MCP key is itself a valid PAT, so no second token is needed.',
        patSource: 'Token source',
        patFromPat: 'PAT from this panel',
        patFromMcpKey: 'reused MCP key',
        patFromNone: 'not configured',
        patVerify: 'Verify credential',
        localSub: 'Source',
        localSubRepo: 'Existing repo build',
        localSubNpm: 'Official npm package (npx)',
        repoDir: 'Repo directory',
        entry: 'Entry file',
        npmTag: 'npm tag / version',
        nodePath: 'node executable',
        nodePathHint: 'Leave empty to use the node bundled with DSH.',
        httpPort: 'HTTP',
        wsPort: 'WebSocket',
        replPort: 'REPL',
        pluginHosting: 'Penpot plugin UI',
        hostingDsh: 'Bundled with the plugin (recommended)',
        hostingPort: 'Let the MCP server serve 4400',
        hostingExternal: 'I host it myself',
        manifest: 'Plugin manifest URL',
        pluginPort: 'Plugin UI port',
        pluginPortHint: 'The plugin serves manifest.json and plugin.js from a small static server; 4400 matches upstream.',
        browser: 'Unattended browser',
        browserHint: 'When nobody opens a page, the plugin launches its own browser. Separate profile, your default browser untouched.',
        browserAuto: 'Let the plugin launch a browser',
        browserAutoHint: 'Off by default — this opens a program for you. penpot_write never needs it.',
        browserPath: 'Browser path',
        browserPathHint: 'Empty = auto-detect Chrome / Edge / Brave. Only Chromium browsers can be driven (Zen is Gecko and has no debug protocol).',
        browserHeadless: 'Headless',
        browserHeadlessHint: 'Turn off for the first login, otherwise you cannot see the form.',
        browserStatus: 'Browser status',
        browserOpen: 'Open design',
        browserClose: 'Close browser',
        browserNotAvailable: 'No drivable browser found',
        selfhostUrl: 'Server URL',
        selfhostHint: 'Copy from your instance: Integrations → MCP Server, e.g. https://your-domain/mcp/stream?userToken=…',
        toolsOn: 'Upstream tools',
        approval: 'Ask before changing a design (execute_code / penpot_write)',
        approvalHint: 'These change things: execute_code runs JS in the design you have open, penpot_write adds, edits or deletes shapes.',
        migrateHint: 'Scans penpot entries on this machine. "Import only" leaves other configs untouched; "import and disable" backs up first and is restorable.',
        scan: 'Scan',
        scanning: 'Scanning…',
        apply: 'Apply',
        importOnly: 'Import only',
        importDisable: 'Import + disable',
        exportSnippet: 'Export snippet',
        none: 'none',
        logs: 'Logs',
        refresh: 'Refresh',
        error: 'Error',
        ok: 'OK',
        noCandidates: 'No penpot entries found.',
        sidebarTitle: 'Penpot',
        sidebarEmpty: 'Not connected yet. Press Start, or click Connect inside Penpot.',
        timeoutMs: 'Call timeout (s)',
        connectMs: 'Connect timeout (s)',
        idleStop: 'Idle stop (minutes, 0 = never)',
      },
    }

    /** 当前语言：从宿主 locale 读，读不到就按浏览器语言猜。 */
    function pickTexts(ctx) {
      try {
        const active = ctx?.locale?.getSnapshot?.()?.active
        if (typeof active === 'string') return active.toLowerCase().startsWith('zh') ? TEXTS.zh : TEXTS.en
      } catch { /* ignore */ }
      try {
        const lang = (navigator.language || '').toLowerCase()
        return lang.startsWith('zh') ? TEXTS.zh : TEXTS.en
      } catch {
        return TEXTS.zh
      }
    }

    // ── API ─────────────────────────────────────────────────────────────────
    async function callApi(action, body) {
      const init = body === undefined
        ? { method: 'GET' }
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json', [WRITE_HEADER]: '1' },
            body: JSON.stringify(body),
          }
      const response = await fetch(`${API}/${action}`, { ...init, credentials: 'same-origin' })
      const payload = await response.json().catch(() => undefined)
      if (payload === undefined) throw new Error(`HTTP ${response.status}`)
      if (payload.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
      return payload.result
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    //
    // 设计原则：窄栏、留白、一屏之内讲完一件事。
    // 之前的版本把状态、选项、说明全堆在一列里，视觉上像一堵墙 —— 改成
    // 「一行一个信息块」，说明文字只在真需要时出现（收起在 hint 里）。
    const CSS = `
      .pnp{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.5;
        color:var(--dsw-alias-label-primary,inherit);max-width:760px}

      /* 头 */
      .pnp-head{display:flex;align-items:center;justify-content:space-between;gap:12px;
        padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .pnp-title{font-weight:600;font-size:15px;margin:0;letter-spacing:-.01em}
      .pnp-dot{display:inline-flex;align-items:center;gap:6px;font-size:12px;
        color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}
      .pnp-dot i{width:6px;height:6px;border-radius:50%;display:inline-block;flex:none}
      .pnp-ok{background:#3fb950}.pnp-warn{background:#d29922}
      .pnp-bad{background:#d64545}.pnp-idle{background:#81858c}

      /* 通道条：横排两格，不是两张大方块 */
      .pnp-chans{display:grid;grid-template-columns:1fr 1fr;gap:8px}
      @media (max-width:560px){.pnp-chans{grid-template-columns:1fr}}
      .pnp-chan{display:flex;flex-direction:column;gap:4px;padding:10px 12px;border-radius:8px;
        background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014);min-width:0}
      .pnp-chan-top{display:flex;align-items:center;gap:6px;min-width:0}
      .pnp-chan-top i{width:6px;height:6px;border-radius:50%;flex:none}
      .pnp-chan-name{font-weight:600;font-size:12px}
      .pnp-chan-state{margin-left:auto;font-size:12px;
        color:var(--dsw-alias-label-secondary,#61666b);white-space:nowrap}
      .pnp-chan-note{font-size:12px;line-height:1.45;
        color:var(--dsw-alias-label-secondary,#61666b);margin:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

      /* 标签页：紧凑，无边框，靠字重和下划线区分 */
      .pnp-tabs{display:flex;gap:16px;border-bottom:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .pnp-tab{padding:0 0 8px;border:none;background:none;
        color:var(--dsw-alias-label-secondary,#61666b);font:inherit;font-size:12px;cursor:pointer;
        border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
      .pnp-tab:hover{color:var(--dsw-alias-label-primary,inherit)}
      .pnp-tab.active{color:var(--dsw-alias-label-primary,inherit);font-weight:600;
        border-bottom-color:var(--dsw-alias-state-business-primary,#2f81f7)}

      /* 内容区 */
      .pnp-body{display:flex;flex-direction:column;gap:18px;min-height:120px}
      .pnp-block{display:flex;flex-direction:column;gap:8px}
      .pnp-block-title{font-weight:600;font-size:12px;margin:0;
        color:var(--dsw-alias-label-secondary,#61666b)}

      /* 键值行：一行一个，标签在左固定宽度 */
      .pnp-rows{display:flex;flex-direction:column;gap:0}
      .pnp-r{display:flex;align-items:baseline;gap:12px;padding:5px 0;font-size:12px;
        border-bottom:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .pnp-r:last-child{border-bottom:none}
      .pnp-r dt{flex:none;width:88px;color:var(--dsw-alias-label-secondary,#61666b);margin:0}
      .pnp-r dd{flex:1;min-width:0;margin:0;word-break:break-all;font-variant-numeric:tabular-nums}
      .pnp-r dd.pnp-num{font-variant-numeric:tabular-nums}

      /* 表单 */
      .pnp-field{display:flex;flex-direction:column;gap:5px}
      .pnp-label{font-size:12px;font-weight:500}
      .pnp-hint{margin:0;color:var(--dsw-alias-label-secondary,#61666b);font-size:12px;line-height:1.45}
      .pnp-input,.pnp-select{width:100%;box-sizing:border-box;padding:6px 9px;border-radius:7px;
        font:inherit;font-size:12px;color:inherit;
        background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .pnp-input:focus,.pnp-select:focus{
        outline:2px solid var(--dsw-alias-state-business-primary,#2f81f7);outline-offset:-1px}
      .pnp-row{display:flex;gap:8px;flex-wrap:wrap}
      .pnp-row>.pnp-field{flex:1;min-width:96px}

      /* 复选 */
      .pnp-check{display:flex;align-items:flex-start;gap:7px;cursor:pointer}
      .pnp-check input{margin:2px 0 0;flex:none;cursor:pointer}
      .pnp-check-text{display:flex;flex-direction:column;gap:2px;min-width:0}

      /* 按钮 */
      .pnp-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
      .pnp-btn{padding:5px 11px;border-radius:7px;font:inherit;font-size:12px;cursor:pointer;
        border:1px solid var(--dsw-alias-line-secondary,#00000014);
        background:var(--dsw-alias-bg-module-platform,#8080800f);color:inherit;
        transition:background .12s,border-color .12s}
      .pnp-btn:hover:not(:disabled){border-color:var(--dsw-alias-line-primary,#00000029)}
      .pnp-btn:disabled{opacity:.45;cursor:default}
      .pnp-btn-primary{background:var(--dsw-alias-state-business-primary,#2f81f7);
        color:#fff;border-color:transparent}
      .pnp-btn-primary:hover:not(:disabled){
        background:var(--dsw-alias-state-business-primary-hover,#1f6fe0)}
      .pnp-btn-quiet{border-color:transparent;background:none;
        color:var(--dsw-alias-label-secondary,#61666b);padding:5px 6px}
      .pnp-btn-quiet:hover:not(:disabled){color:inherit;background:none}

      /* 消息 */
      .pnp-msg{font-size:12px;margin:0;white-space:pre-wrap;line-height:1.5;
        padding:7px 10px;border-radius:7px}
      .pnp-msg-ok{color:#2ea043;background:#3fb95012}
      .pnp-msg-bad{color:#cf222e;background:#d6454512}
      .pnp-msg-info{color:var(--dsw-alias-label-secondary,#61666b);
        background:var(--dsw-alias-bg-module-platform,#8080800f)}

      /* 标签 */
      .pnp-tags{display:flex;gap:5px;flex-wrap:wrap}
      .pnp-tag{font-size:10px;padding:1px 7px;border-radius:999px;
        background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014);
        color:var(--dsw-alias-label-secondary,#61666b)}

      /* 日志 */
      .pnp-pre{margin:0;padding:9px 11px;border-radius:7px;overflow:auto;max-height:200px;
        font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
        font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-all;
        background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014);
        color:var(--dsw-alias-label-secondary,#61666b)}

      /* 迁移候选 */
      .pnp-cand{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:8px;
        background:var(--dsw-alias-bg-module-platform,#8080800f);
        border:1px solid var(--dsw-alias-line-secondary,#00000014)}
      .pnp-cand-head{display:flex;align-items:center;gap:8px;justify-content:space-between}
      .pnp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
        word-break:break-all;color:var(--dsw-alias-label-secondary,#61666b)}

      /* 探测进度：细条 */
      .pnp-stages{display:inline-flex;gap:3px;align-items:center;vertical-align:middle}
      .pnp-stage{width:14px;height:3px;border-radius:2px;
        background:var(--dsw-alias-line-secondary,#00000014)}
      .pnp-stage.on{background:#3fb950}
      .pnp-stage.cur{background:#d29922}

      /* 保存按钮：浮在右下角，只占它自己那一小块。
         之前是一条带边框和背景的横条，滚动时会盖住底下的设置项 —— 这里改成
         容器透明、只有按钮可点（pointer-events 分开管），视觉上像一个悬浮胶囊。 */
      .pnp-foot{position:sticky;bottom:10px;display:flex;justify-content:flex-end;
        align-self:flex-end;margin-top:4px;pointer-events:none;z-index:2}
      .pnp-foot>.pnp-btn{pointer-events:auto;
        box-shadow:0 2px 8px #00000029,0 0 0 1px #0000000d;
        padding:7px 16px;font-weight:500}
      
      /* 侧栏：更窄，只留最常用的 */
      .pnp-side{display:flex;flex-direction:column;gap:12px;font-size:12px;padding:12px}
      .pnp-side .pnp-chans{grid-template-columns:1fr}
    `

    function ensureStyle() {
      const key = '__dsh_penpot_style__'
      if (document[key] === true) return
      const tag = document.createElement('style')
      tag.dataset.source = 'dsh-plugin-penpot'
      tag.textContent = CSS
      document.head.appendChild(tag)
      document[key] = true
    }

    // ── 小组件 ──────────────────────────────────────────────────────────────
    function Field(props) {
      return h('div', { className: 'pnp-field' }, [
        props.label === undefined ? null : h('label', { className: 'pnp-label', key: 'l' }, props.label),
        h('div', { key: 'c' }, props.children),
        props.hint === undefined ? null : h('p', { className: 'pnp-hint', key: 'h' }, props.hint),
      ])
    }

    function Check(props) {
      return h('label', { className: 'pnp-check' }, [
        h('input', {
          key: 'i',
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: event => props.onChange(event.target.checked),
        }),
        h('span', { className: 'pnp-check-text', key: 't' }, [
          h('span', { key: 'a' }, props.label),
          props.hint === undefined ? null : h('span', { className: 'pnp-hint', key: 'b' }, props.hint),
        ]),
      ])
    }

    function Select(props) {
      return h('select', {
        className: 'pnp-select',
        value: props.value,
        disabled: props.disabled === true,
        onChange: event => props.onChange(event.target.value),
      }, props.options.map(option => h('option', { key: option.value, value: option.value }, option.label)))
    }

    function Text(props) {
      return h('input', {
        className: 'pnp-input',
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder,
        disabled: props.disabled === true,
        spellCheck: false,
        onChange: event => props.onChange(event.target.value),
      })
    }

    function Button(props) {
      return h('button', {
        type: 'button',
        className: `pnp-btn${props.primary === true ? ' pnp-btn-primary' : ''}${props.quiet === true ? ' pnp-btn-quiet' : ''}`,
        disabled: props.disabled === true,
        onClick: props.onClick,
        title: props.title,
      }, props.children)
    }

    function Message(props) {
      if (props.text === undefined || props.text === null || props.text === '') return null
      const kind = props.kind ?? 'info'
      return h('p', { className: `pnp-msg pnp-msg-${kind}` }, props.text)
    }

    /**
     * 一行键值。
     *
     * 为什么不用 grid 而用 dl 单行：grid 在窄栏里会把标签和值挤成两堵墙，
     * 逐行的 dt/dd 更像「读一条信息」，也更好对齐。
     */
    function Row(props) {
      return h('div', { className: 'pnp-r' }, [
        h('dt', { key: 't' }, props.label),
        h('dd', { key: 'd', className: props.mono === true ? 'pnp-mono' : undefined }, props.children),
      ])
    }

    /**
     * 一条通道的紧凑状态条。
     *
     * 两个通道能独立好坏：MCP 需要标签页，REST 不需要。用一条横排表示，
     * 而不是一张大方块 —— 方块在窄栏里占掉半屏，信息密度却很低。
     *
     * `desc` 放进 title：想深究的人悬停能看到，不想看的人不会被它挤到。
     */
    function Channel(props) {
      const tone = props.ok === true ? 'pnp-ok' : props.warn === true ? 'pnp-warn' : 'pnp-bad'
      return h('div', { className: 'pnp-chan', title: props.desc }, [
        h('div', { className: 'pnp-chan-top', key: 'h' }, [
          h('i', { key: 'i', className: tone }),
          h('span', { key: 'n', className: 'pnp-chan-name' }, props.name),
          h('span', { key: 's', className: 'pnp-chan-state' }, props.state),
        ]),
        h('p', { className: 'pnp-chan-note', key: 'p', title: props.note }, props.note),
      ])
    }

    function StatusDot(props) {
      const state = props.state ?? 'idle'
      const cls = state === 'running' || state === 'rest' ? 'pnp-ok'
        : state === 'waiting' || state === 'starting' || state === 'stopping' ? 'pnp-warn'
          : state === 'degraded' ? 'pnp-bad' : 'pnp-idle'
      return h('span', { className: 'pnp-dot' }, [
        h('i', { key: 'i', className: cls }),
        h('span', { key: 't' }, props.label),
      ])
    }

    /** 探测进度：一格一格的细条，不抢视线。 */
    function StageBar(props) {
      const order = ['endpoint', 'no-token', 'no-instance', 'ok']
      const index = order.indexOf(props.stage)
      return h('div', { className: 'pnp-stages', title: props.detail ?? '' }, order.map((stage, i) => h('span', {
        key: stage,
        className: `pnp-stage${i < index ? ' on' : i === index ? ' cur' : ''}`,
      })))
    }

    // ── 状态读取 hook ───────────────────────────────────────────────────────
    /**
     * 周期性拉 /api/penpot/status。
     *
     * intervalMs 为 0 表示不轮询（侧栏不可见时用），但仍然会拉一次 ——
     * 第一次就要有数据，否则面板会先空一段时间。
     */
    function useStatus(intervalMs) {
      const [state, setState] = React.useState({ loaded: false, status: undefined, config: undefined, error: undefined })
      const load = React.useCallback(async () => {
        try {
          const status = await callApi('status')
          setState(prev => ({
            ...prev,
            loaded: true,
            status: status.result ?? status,
            config: status.config ?? prev.config,
            error: undefined,
          }))
        } catch (error) {
          setState(prev => ({ ...prev, loaded: true, error: String(error?.message ?? error) }))
        }
      }, [])
      React.useEffect(() => {
        void load()
        if (!(intervalMs > 0)) return undefined
        const timer = setInterval(() => { void load() }, intervalMs)
        return () => clearInterval(timer)
      }, [load, intervalMs])
      return { ...state, reload: load }
    }

    // ── 主卡片 ──────────────────────────────────────────────────────────────
    /**
     * 插件页卡片。
     *
     * 布局是一列到底但**分成五页**：概览 / 连接 / 自动化 / 迁移 / 高级。
     * 之前所有东西堆在一屏，读起来像一堵墙；现在每页只回答一个问题。
     *
     * 状态全在组件里，不进宿主 store —— 这个插件没有跨视图共享的需求。
     */
    function PenpotCard(props) {
      // 槽会把 `inject()` 的返回值摊进来，同时可能带 locale。
      // 两者都要能容错：拿不到就用浏览器语言猜。
      const t = props?.t ?? pickTexts(props?.ctx) ?? TEXTS.zh
      const { loaded, status, config, error, reload } = useStatus(4000)

      const [busy, setBusy] = React.useState('')
      const [message, setMessage] = React.useState(undefined)
      const [probe, setProbe] = React.useState(undefined)
      const [form, setForm] = React.useState(undefined)
      const [saved, setSaved] = React.useState(undefined)
      const [detect, setDetect] = React.useState(undefined)
      const [migration, setMigration] = React.useState(undefined)
      const [logs, setLogs] = React.useState(undefined)
      const [manifest, setManifest] = React.useState(undefined)
      const [browser, setBrowser] = React.useState(undefined)
      const [tab, setTab] = React.useState('status')

      /**
       * 表单的「干净快照」—— 用来判断有没有未保存的改动。
       *
       * 三个粘贴框（officialPaste / selfhostPaste / patToken）永远算空：
       * 它们是一次性的输入通道，不是状态。不排除掉的话，只要用户在里面
       * 贴过一次东西，保存栏就会永远挂着。
       */
      const snapshotOf = value => (value === undefined ? '' : JSON.stringify({
        ...value,
        officialPaste: '',
        selfhostPaste: '',
        patToken: '',
      }))

      React.useEffect(() => {
        if (config === undefined || form !== undefined) return
        const initial = {
          mode: config.mode,
          startup: config.startup,
          requireApproval: config.requireApproval,
          exposeControlTool: config.exposeControlTool,
          toolCallTimeoutMs: Math.round((config.toolCallTimeoutMs ?? 180000) / 1000),
          connectTimeoutMs: Math.round((config.connectTimeoutMs ?? 60000) / 1000),
          idleStopMinutes: config.idleStopMinutes ?? 0,
          officialEndpoint: cleanEndpoint(config.official?.endpoint),
          officialPaste: '',
          localSub: config.local?.sub ?? 'repo',
          repoDir: config.local?.repoDir ?? '',
          entry: config.local?.entry ?? '',
          nodePath: config.local?.nodePath ?? '',
          npmTag: config.local?.npmTag ?? 'stable',
          httpPort: String(config.local?.httpPort ?? 4401),
          wsPort: String(config.local?.wsPort ?? 4402),
          replPort: String(config.local?.replPort ?? 4403),
          pluginHosting: config.local?.pluginHosting ?? 'bundled',
          pluginPort: String(config.local?.pluginPort ?? 4400),
          selfhostUrl: cleanEndpoint(config.selfhost?.url),
          selfhostPaste: '',
          selfhostInsecure: config.selfhost?.allowInsecureTLS === true,
          patToken: '',
          patReuse: config.pat?.reuseMcpKey !== false,
          browserAuto: config.browser?.autoLaunch === true,
          browserPath: config.browser?.path ?? '',
          browserHeadless: config.browser?.headless === true,
          openFileId: '',
          openTeamId: '',
        }
        setForm(initial)
        setSaved(snapshotOf(initial))
      }, [config, form])

      const patch = React.useCallback((key, value) => {
        setForm(prev => (prev === undefined ? prev : { ...prev, [key]: value }))
      }, [])

      const run = React.useCallback(async (label, fn) => {
        setBusy(label)
        setMessage(undefined)
        try {
          const result = await fn()
          await reload()
          return result
        } catch (err) {
          setMessage({ kind: 'bad', text: String(err?.message ?? err) })
          return undefined
        } finally {
          setBusy('')
        }
      }, [reload])

      const save = () => run('save', async () => {
        if (form === undefined) return undefined
        const body = { patch: {} }
        body.patch.mode = form.mode
        body.patch.startup = form.startup
        body.patch.requireApproval = form.requireApproval === true
        body.patch.exposeControlTool = form.exposeControlTool === true
        body.patch.toolCallTimeoutMs = Math.max(5, Number(form.toolCallTimeoutMs) || 180) * 1000
        body.patch.connectTimeoutMs = Math.max(3, Number(form.connectTimeoutMs) || 60) * 1000
        body.patch.idleStopMinutes = Math.max(0, Number(form.idleStopMinutes) || 0)
        body.patch.official = { endpoint: form.officialEndpoint.trim() }
        if (form.officialPaste.trim() !== '') body.patch.official.paste = form.officialPaste.trim()
        body.patch.local = {
          sub: form.localSub,
          repoDir: form.repoDir,
          entry: form.entry,
          nodePath: form.nodePath,
          npmTag: form.npmTag,
          httpPort: Number(form.httpPort) || 4401,
          wsPort: Number(form.wsPort) || 4402,
          replPort: Number(form.replPort) || 4403,
          pluginHosting: form.pluginHosting,
          pluginPort: Number(form.pluginPort) || 4400,
        }
        const selfhostUrl = form.selfhostPaste.trim() !== '' ? form.selfhostPaste.trim() : form.selfhostUrl
        body.patch.selfhost = { url: selfhostUrl, allowInsecureTLS: form.selfhostInsecure }
        // PAT：只在用户真的输入了新值时才写（输入框永远是空的，不回显）
        body.patch.pat = { reuseMcpKey: form.patReuse }
        if (form.patToken.trim() !== '') body.patch.pat.token = form.patToken.trim()
        body.patch.browser = { autoLaunch: form.browserAuto === true, headless: form.browserHeadless === true }
        if (form.browserPath.trim() !== '') body.patch.browser.path = form.browserPath.trim()
        const result = await callApi('config.set', body)
        setMessage({ kind: 'ok', text: t.saved })
        const next = { ...form, officialPaste: '', selfhostPaste: '', patToken: '' }
        setForm(next)
        setSaved(snapshotOf(next))
        return result
      })

      const doVerifyToken = () => run('pat', async () => {
        const result = await callApi('service', { op: 'patProbe' })
        setMessage({
          kind: result.stage === 'ok' ? 'ok' : 'info',
          text: result.detail,
        })
        return result
      })

      const doProbe = () => run('probe', async () => {
        const result = await callApi('service', { op: 'probe' })
        setProbe(result)
        setMessage({ kind: result.stage === 'ok' ? 'ok' : 'info', text: result.detail })
        return result
      })

      const doService = op => run(op, async () => {
        const result = await callApi('service', { op })
        setMessage({
          kind: result?.ok === false ? 'bad' : 'ok',
          text: describeServiceResult(op, result, t),
        })
        return result
      })

      const doDetect = () => run('detect', async () => {
        const result = await callApi('detect')
        setDetect(result)
        setMessage({ kind: 'info', text: result.rationale })
        return result
      })

      const doApplyDetected = () => run('applyDetected', async () => {
        const result = await callApi('detect.apply')
        setMessage({ kind: 'ok', text: t.saved })
        return result
      })

      const doScan = () => run('scan', async () => {
        const result = await callApi('migrate.scan')
        setMigration({ scan: result, selection: {} })
        setMessage({ kind: 'info', text: result.candidates.length === 0 ? t.noCandidates : `${result.candidates.length} 条` })
        return result
      })

      const doApplyMigration = () => run('migrate', async () => {
        const selection = migration?.selection ?? {}
        const entries = []
        for (const candidate of migration?.scan?.candidates ?? []) {
          const action = selection[candidateKey(candidate)]
          if (action === undefined || action === '') continue
          entries.push({ candidate, action })
        }
        if (entries.length === 0) {
          setMessage({ kind: 'info', text: t.nothingSelected })
          return undefined
        }
        const result = await callApi('migrate.apply', { entries })
        // 勾了「导出片段」的话，产物要真给出来 —— 否则用户点完什么也拿不到
        const snippets = Array.isArray(result.snippets) ? result.snippets : []
        setMigration(prev => ({ ...(prev ?? {}), result }))
        setMessage({
          kind: result.ok === true ? 'ok' : 'bad',
          text: result.ok === true
            ? `已处理 ${result.applied?.length ?? 0} 条${result.backupDir === undefined ? '' : `，备份在 ${result.backupDir}`}${snippets.length === 0 ? '' : `，生成了 ${snippets.length} 段配置片段（见下方）`}${(result.warnings ?? []).length > 0 ? `\n${result.warnings.join('\n')}` : ''}`
            : String(result.error),
        })
        return result
      })

      const doLoadLogs = () => run('logs', async () => {
        const result = await callApi('logs?lines=120')
        setLogs(result.text)
        return result
      })

      const doManifest = () => run('manifest', async () => {
        const result = await callApi('manifest')
        setManifest(result)
        return result
      })

      const doBrowserStatus = () => run('browser', async () => {
        const result = await callApi('service', { op: 'browserStatus' })
        setBrowser(result)
        if (result.available !== true) setMessage({ kind: 'info', text: result.reason })
        return result
      })

      const doOpenDesign = () => run('openDesign', async () => {
        const result = await callApi('service', { op: 'openDesign', fileId: form?.openFileId ?? '', teamId: form?.openTeamId ?? '' })
        setMessage({
          kind: result.ok === true ? 'ok' : 'bad',
          text: result.ok === true
            ? `${result.url}${result.loginHint === undefined ? '' : `\n${result.loginHint}`}`
            : String(result.reason),
        })
        return result
      })

      const doCloseBrowser = () => run('closeBrowser', async () => {
        const result = await callApi('service', { op: 'closeBrowser' })
        setMessage({
          kind: 'info',
          text: result.closed === true ? `pid ${result.pid}` : String(result.reason ?? ''),
        })
        return result
      })

      const stateLabel = status === undefined ? '—' : (t[`state_${status.state}`] ?? status.state)
      const stage = probe?.stage ?? status?.lastProbe?.stage
      const channels = status?.channels
      const modeOptions = [
        { value: 'auto', label: t.modeAuto },
        { value: 'official', label: t.modeOfficial },
        { value: 'local', label: t.modeLocal },
        { value: 'selfhost', label: t.modeSelfhost },
      ]

      // 有没有未保存的改动 —— 只在这个状态下才显示保存栏
      const dirty = form !== undefined && saved !== undefined && snapshotOf(form) !== saved

      const tabs = [
        { id: 'status', label: t.tabStatus },
        { id: 'conn', label: t.tabConnection },
        { id: 'auto', label: t.tabAutomation },
        { id: 'migrate', label: t.tabMigrate },
        { id: 'adv', label: t.tabAdvanced },
      ]

      return h('section', { className: 'pnp', 'data-penpot-card': '1' }, [
        // 头：只有名字和总状态
        h('div', { className: 'pnp-head', key: 'head' }, [
          h('p', { className: 'pnp-title', key: 't' }, `${t.title} MCP`),
          h(StatusDot, { key: 'r', state: status?.state, label: stateLabel }),
        ]),

        error === undefined ? null : h(Message, { key: 'err', kind: 'bad', text: `${t.error}: ${error}` }),
        message === undefined ? null : h(Message, { key: 'msg', kind: message.kind, text: message.text }),

        // 两条通道并排，一眼看完
        channels === undefined ? null : h('div', { className: 'pnp-chans', key: 'chan' }, [
          h(Channel, {
            key: 'mcp',
            name: 'MCP',
            ok: channels.mcp.usable,
            warn: channels.mcp.stage === 'no-instance',
            state: channels.mcp.label,
            note: channels.mcp.needsTab === true ? t.chanNeedsTab : t.chanNoTab,
            desc: t.chanMcpDesc,
          }),
          h(Channel, {
            key: 'rest',
            name: 'REST',
            ok: channels.rest.usable,
            warn: channels.rest.configured === true,
            state: channels.rest.usable ? t.chanOk : restLabel(channels.rest.stage, t),
            note: channels.rest.needsTab === true ? t.chanNeedsTab : t.chanNoTab,
            desc: t.chanRestDesc,
          }),
        ]),

        // 标签页
        h('div', { className: 'pnp-tabs', key: 'tabs' }, tabs.map(def => h('button', {
          key: def.id,
          type: 'button',
          className: `pnp-tab${tab === def.id ? ' active' : ''}`,
          onClick: () => setTab(def.id),
        }, def.label))),

        // ── 概览 ──────────────────────────────────────────────────────────
        tab !== 'status' ? null : h('div', { className: 'pnp-body', key: 'p-status' }, [
          h('dl', { className: 'pnp-rows', key: 'rows' }, [
            h(Row, { key: 'r1', label: t.mode }, modeLabel(status?.mode, t)),
            h(Row, { key: 'r2', label: t.endpoint, mono: true }, status?.endpoint || t.none),
            h(Row, { key: 'r3', label: t.tools }, [
              h('span', { key: 'n' }, String(status?.toolCount ?? 0)),
              status?.pid === undefined ? null : h('span', { key: 'p' }, ` · ${t.pid} ${status.pid}`),
            ]),
            h(Row, { key: 'r4', label: t.probe }, [
              h(StageBar, { key: 'bar', stage, detail: probe?.detail ?? status?.lastProbe?.detail }),
              h('span', { key: 'l' }, ` ${labelOfStage(stage, t)}`),
            ]),
            config?.detected?.from === undefined ? null : h(Row, { key: 'r5', label: t.detectedFrom, mono: true }, config.detected.from),
          ]),

          h('div', { className: 'pnp-actions', key: 'act' }, [
            h(Button, { key: 'start', primary: true, disabled: busy !== '', onClick: () => doService('start') }, busy === 'start' ? '…' : t.start),
            h(Button, { key: 'stop', disabled: busy !== '', onClick: () => doService('stop') }, t.stop),
            h(Button, { key: 'probe', disabled: busy !== '', onClick: doProbe }, busy === 'probe' ? t.probing : t.probe),
            h(Button, { key: 'pat', disabled: busy !== '', onClick: doVerifyToken }, busy === 'pat' ? '…' : t.patVerify),
            h(Button, { key: 'refresh', quiet: true, disabled: busy !== '', onClick: () => { void reload() } }, t.refresh),
          ]),

          h('div', { className: 'pnp-block', key: 'logs' }, [
            h('div', { className: 'pnp-actions', key: 'h' }, [
              h('p', { className: 'pnp-block-title', key: 't' }, t.logs),
              h(Button, { key: 'b', quiet: true, disabled: busy !== '', onClick: doLoadLogs }, busy === 'logs' ? '…' : t.show),
            ]),
            logs === undefined ? null : h('pre', { className: 'pnp-pre', key: 'p' }, logs === '' ? t.none : logs),
          ]),
        ]),

        // ── 连接 ──────────────────────────────────────────────────────────
        tab !== 'conn' || form === undefined ? null : h('div', { className: 'pnp-body', key: 'p-conn' }, [
          h(Field, { key: 'mode', label: t.connMode, hint: form.mode === 'auto' ? t.autoHint : undefined }, [
            h(Select, { value: form.mode, options: modeOptions, onChange: value => patch('mode', value) }),
          ]),

          detect === undefined ? null : h('div', { className: 'pnp-block', key: 'detect' }, [
            h('p', { className: 'pnp-hint', key: 'r' }, detect.rationale),
            (detect.candidates ?? []).length === 0 ? null : h('div', { className: 'pnp-tags', key: 'tags' },
              detect.candidates.map(candidate => h('span', { key: candidateKey(candidate), className: 'pnp-tag' },
                `${sourceLabel(candidate.source)} ${candidate.name}`))),
            h(Button, { key: 'a', disabled: busy !== '', onClick: doApplyDetected }, t.applyDetected),
          ]),

          form.mode === 'official' || form.mode === 'auto' ? h('div', { className: 'pnp-block', key: 'off' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.modeOfficial),
            h(Field, { key: 'ep', label: t.officialEndpoint }, [
              h(Text, { value: form.officialEndpoint, onChange: value => patch('officialEndpoint', value) }),
            ]),
            h(Field, { key: 'paste', label: t.pasteUrl, hint: t.pasteUrlHint }, [
              h(Text, { value: form.officialPaste, placeholder: 'https://design.penpot.app/mcp/stream?userToken=…', onChange: value => patch('officialPaste', value) }),
            ]),
            h('p', { className: 'pnp-hint', key: 'tok' },
              `${t.officialToken}: ${config?.official?.auth?.configured === true ? t.tokenConfigured : t.tokenEmpty}`),
          ]) : null,

          form.mode === 'selfhost' ? h('div', { className: 'pnp-block', key: 'sh' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.modeSelfhost),
            h(Field, { key: 'u', label: t.selfhostUrl, hint: t.selfhostHint }, [
              h(Text, { value: form.selfhostUrl, placeholder: 'https://penpot.example.com/mcp/stream?userToken=…', onChange: value => patch('selfhostUrl', value) }),
            ]),
            h(Field, { key: 'p', label: t.pasteUrl }, [
              h(Text, { value: form.selfhostPaste, onChange: value => patch('selfhostPaste', value) }),
            ]),
            h(Check, {
              key: 'i',
              checked: form.selfhostInsecure,
              label: t.selfhostInsecure,
              onChange: value => patch('selfhostInsecure', value),
            }),
          ]) : null,

          form.mode === 'local' || form.mode === 'auto' ? h('div', { className: 'pnp-block', key: 'loc' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.modeLocal),
            h(Field, { key: 'sub', label: t.localSub }, [
              h(Select, {
                value: form.localSub,
                options: [
                  { value: 'repo', label: t.localSubRepo },
                  { value: 'npm', label: t.localSubNpm },
                ],
                onChange: value => patch('localSub', value),
              }),
            ]),
            form.localSub === 'repo' ? h(Field, { key: 'repo', label: t.repoDir }, [
              h(Text, { value: form.repoDir, onChange: value => patch('repoDir', value) }),
            ]) : null,
            form.localSub === 'repo' ? h(Field, { key: 'entry', label: t.entry }, [
              h(Text, { value: form.entry, onChange: value => patch('entry', value) }),
            ]) : null,
            form.localSub === 'npm' ? h(Field, { key: 'tag', label: t.npmTag }, [
              h(Text, { value: form.npmTag, onChange: value => patch('npmTag', value) }),
            ]) : null,
            h(Field, { key: 'node', label: t.nodePath, hint: t.nodePathHint }, [
              h(Text, { value: form.nodePath, onChange: value => patch('nodePath', value) }),
            ]),
            h('div', { className: 'pnp-row', key: 'ports' }, [
              h(Field, { key: 'h', label: t.httpPort }, [
                h(Text, { value: form.httpPort, onChange: value => patch('httpPort', value) }),
              ]),
              h(Field, { key: 'w', label: t.wsPort }, [
                h(Text, { value: form.wsPort, onChange: value => patch('wsPort', value) }),
              ]),
              h(Field, { key: 'r', label: t.replPort }, [
                h(Text, { value: form.replPort, onChange: value => patch('replPort', value) }),
              ]),
            ]),
            h(Field, { key: 'hosting', label: t.pluginHosting, hint: form.pluginHosting === 'bundled' ? t.pluginPortHint : undefined }, [
              h(Select, {
                value: form.pluginHosting,
                options: [
                  { value: 'bundled', label: t.hostingDsh },
                  { value: 'port', label: t.hostingPort },
                  { value: 'external', label: t.hostingExternal },
                ],
                onChange: value => patch('pluginHosting', value),
              }),
            ]),
            form.pluginHosting === 'bundled' ? h(Field, { key: 'pluginPort', label: t.pluginPort }, [
              h(Text, { value: form.pluginPort, onChange: value => patch('pluginPort', value) }),
            ]) : null,
            h('div', { className: 'pnp-actions', key: 'mfg' }, [
              h(Button, { key: 'm', disabled: busy !== '', onClick: doManifest }, t.manifest),
              manifest === undefined || manifest.needed === false
                ? null
                : h('span', { key: 'u', className: 'pnp-mono' }, manifest.url),
            ]),
            manifest === undefined ? null : h(Message, {
              key: 'mn',
              kind: 'info',
              text: manifest.needed === false ? manifest.reason : `${manifest.note ?? ''}${manifest.ws === undefined ? '' : `\n${manifest.ws}`}`,
            }),
          ]) : null,

          h(Field, { key: 'startup', label: t.startup }, [
            h(Select, {
              value: form.startup,
              options: [
                { value: 'lazy', label: t.startupLazy },
                { value: 'auto', label: t.startupAuto },
              ],
              onChange: value => patch('startup', value),
            }),
          ]),

          // 凭据：PAT 只在远端档有意义（本地服务没有 REST API）
          form.mode === 'local' ? null : h('div', { className: 'pnp-block', key: 'pat' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.pat),
            h('p', { className: 'pnp-hint', key: 'h' }, t.patHint),
            h(Field, { key: 'token', label: t.patToken }, [
              h(Text, { value: form.patToken, placeholder: t.pasteToken, onChange: value => patch('patToken', value) }),
            ]),
            h(Check, {
              key: 'reuse',
              checked: form.patReuse === true,
              label: t.patReuse,
              hint: t.patReuseHint,
              onChange: value => patch('patReuse', value),
            }),
            h('p', { className: 'pnp-hint', key: 'src' },
              `${t.patSource}: ${config?.pat?.from === 'pat' ? t.patFromPat : config?.pat?.from === 'mcp-key' ? t.patFromMcpKey : t.patFromNone}`
              + (config?.pat?.apiBase === undefined || config?.pat?.apiBase === '' ? '' : `　${config.pat.apiBase}`)),
          ]),
        ]),

        // ── 自动化 ────────────────────────────────────────────────────────
        tab !== 'auto' || form === undefined ? null : h('div', { className: 'pnp-body', key: 'p-auto' }, [
          h('div', { className: 'pnp-block', key: 'rest' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.autoRestTitle),
            h('p', { className: 'pnp-hint', key: 'h' }, t.autoRestHint),
          ]),

          form.mode === 'local' ? null : h('div', { className: 'pnp-block', key: 'br' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.browser),
            h('p', { className: 'pnp-hint', key: 'h' }, t.browserHint),
            h(Check, {
              key: 'auto',
              checked: form.browserAuto === true,
              label: t.browserAuto,
              hint: t.browserAutoHint,
              onChange: value => patch('browserAuto', value),
            }),
            h('div', { className: 'pnp-row', key: 'br2' }, [
              h(Field, { key: 'bp', label: t.browserPath, hint: t.browserPathHint }, [
                h(Text, { value: form.browserPath, placeholder: t.browserPathPlaceholder, onChange: value => patch('browserPath', value) }),
              ]),
              h(Field, { key: 'fid', label: t.openFileId, hint: t.openFileIdHint }, [
                h(Text, { value: form.openFileId, onChange: value => patch('openFileId', value) }),
              ]),
              h(Field, { key: 'tid', label: t.openTeamId, hint: t.openTeamIdHint }, [
                h(Text, { value: form.openTeamId, onChange: value => patch('openTeamId', value) }),
              ]),
            ]),
            h(Check, {
              key: 'hl',
              checked: form.browserHeadless === true,
              label: t.browserHeadless,
              hint: t.browserHeadlessHint,
              onChange: value => patch('browserHeadless', value),
            }),
            h('div', { className: 'pnp-actions', key: 'bact' }, [
              h(Button, { key: 'op', primary: true, disabled: busy !== '', onClick: doOpenDesign }, busy === 'openDesign' ? '…' : t.browserOpen),
              h(Button, { key: 'st', disabled: busy !== '', onClick: doBrowserStatus }, busy === 'browser' ? '…' : t.browserStatus),
              h(Button, { key: 'cl', quiet: true, disabled: busy !== '', onClick: doCloseBrowser }, busy === 'closeBrowser' ? '…' : t.browserClose),
            ]),
            browser === undefined ? null : (browser.available === true
              ? h('p', { className: 'pnp-hint', key: 'bs' },
                `${browser.kind}　${browser.running === true ? `pid ${browser.pid} · ${browser.url}` : t.browserNotRunning}`)
              : h(Message, { key: 'bn', kind: 'info', text: `${t.browserNotAvailable}：${browser.reason}` })),
          ]),

          h('div', { className: 'pnp-block', key: 'tools' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.toolsOn),
            (status?.tools ?? []).length === 0
              ? h('p', { className: 'pnp-hint', key: 'e' }, t.none)
              : h('div', { className: 'pnp-tags', key: 'tags' }, (status?.tools ?? []).map(name => h('span', { key: name, className: 'pnp-tag' }, name))),
            h(Check, {
              key: 'ap',
              checked: form.requireApproval,
              label: t.approval,
              hint: t.approvalHint,
              onChange: value => patch('requireApproval', value),
            }),
            h(Check, {
              key: 'ct',
              checked: form.exposeControlTool,
              label: t.exposeControlLabel,
              onChange: value => patch('exposeControlTool', value),
            }),
          ]),
        ]),

        // ── 迁移 ──────────────────────────────────────────────────────────
        tab !== 'migrate' ? null : h('div', { className: 'pnp-body', key: 'p-migrate' }, [
          h('p', { className: 'pnp-hint', key: 'h' }, t.migrateHint),
          h('div', { className: 'pnp-actions', key: 'a' }, [
            h(Button, { key: 's', disabled: busy !== '', onClick: doScan }, busy === 'scan' ? t.scanning : t.scan),
            h(Button, { key: 'ap', primary: true, disabled: busy !== '' || migration === undefined, onClick: doApplyMigration }, t.apply),
          ]),
          migration === undefined
            ? null
            : h('div', { className: 'pnp-block', key: 'cands' }, (migration.scan?.candidates ?? []).map(candidate => {
              const key = candidateKey(candidate)
              const selected = migration.selection?.[key] ?? candidate.suggested ?? 'import-only'
              return h('div', { className: 'pnp-cand', key }, [
                h('div', { className: 'pnp-cand-head', key: 'h' }, [
                  h('span', { key: 'n' }, `${sourceLabel(candidate.source)} · ${candidate.name}`),
                  h('span', { className: 'pnp-tag', key: 'k' }, modeLabel(candidate.kind, t)),
                ]),
                h('div', { className: 'pnp-mono', key: 'p' }, `${candidate.path}${candidate.line === undefined ? '' : `:${candidate.line}`}`),
                candidate.blocker === undefined ? null : h(Message, { key: 'b', kind: 'bad', text: candidate.blocker }),
                h(Select, {
                  key: 'act',
                  value: selected,
                  options: [
                    { value: 'import-only', label: t.importOnly },
                    { value: 'import-and-disable', label: t.importDisable },
                    { value: 'export-snippet', label: t.exportSnippet },
                    { value: '', label: t.skip },
                  ],
                  onChange: value => setMigration(prev => ({
                    ...prev,
                    selection: { ...(prev?.selection ?? {}), [key]: value },
                  })),
                }),
              ])
            })),
          // 「导出片段」的产物：真正给出可粘贴的 JSON / TOML
          (migration.result?.snippets ?? []).length === 0 ? null : h('div', { className: 'pnp-block', key: 'snips' }, [
            h('p', { className: 'pnp-block-title', key: 't' }, t.exportSnippet),
            ...(migration.result.snippets ?? []).map(snippet => h('div', { className: 'pnp-cand', key: snippet.name }, [
              h('div', { className: 'pnp-cand-head', key: 'h' }, [
                h('span', { key: 'n' }, `${sourceLabel(snippet.source)} · ${snippet.name}`),
              ]),
              h('pre', { className: 'pnp-pre', key: 'j' }, snippet.json),
              h('pre', { className: 'pnp-pre', key: 't' }, snippet.toml),
            ])),
          ]),
        ]),

        // ── 高级 ──────────────────────────────────────────────────────────
        tab !== 'adv' || form === undefined ? null : h('div', { className: 'pnp-body', key: 'p-adv' }, [
          h(Field, { key: 'to', label: t.timeoutMs }, [
            h(Text, { value: String(form.toolCallTimeoutMs), onChange: value => patch('toolCallTimeoutMs', value) }),
          ]),
          h(Field, { key: 'co', label: t.connectMs, hint: t.connectMsHint }, [
            h(Text, { value: String(form.connectTimeoutMs), onChange: value => patch('connectTimeoutMs', value) }),
          ]),
          h(Field, { key: 'idle', label: t.idleStop }, [
            h(Text, { value: String(form.idleStopMinutes), onChange: value => patch('idleStopMinutes', value) }),
          ]),
          h('div', { className: 'pnp-actions', key: 'restartRow' }, [
            h(Button, { key: 'restart', disabled: busy !== '', onClick: () => doService('restart') }, t.restart),
            h(Button, { key: 'detect', disabled: busy !== '', onClick: doDetect }, busy === 'detect' ? '…' : t.redetect),
          ]),
        ]),

        // 底部保存栏：只在有改动时出现，不占地方
        dirty !== true ? null : h('div', { className: 'pnp-foot', key: 'foot' }, [
          h(Button, { key: 's', primary: true, disabled: busy !== '', onClick: save }, busy === 'save' ? t.saving : t.save),
        ]),
      ])
    }

    // ── 文案小工具 ──────────────────────────────────────────────────────────
    function modeLabel(mode, t) {
      if (mode === 'official') return t.modeOfficial
      if (mode === 'local') return t.modeLocal
      if (mode === 'selfhost') return t.modeSelfhost
      return t.modeAuto
    }

    function labelOfStage(stage, t) {
      if (stage === 'ok') return t.stage_ok
      if (stage === 'no-token') return t.stageNoToken
      if (stage === 'no-instance') return t.stageNoInstance
      return t.stage_endpoint
    }

    /** REST 通道的五个级各有各的说法（比 MCP 多一个「令牌无效」）。 */
    function restLabel(stage, t) {
      if (stage === 'ok') return t.chanOk
      if (stage === 'no-token') return t.chanNoToken
      if (stage === 'bad-token') return t.chanBadToken
      if (stage === 'blocked') return t.chanBlocked
      return t.chanUnchecked
    }

    function sourceLabel(source) {
      switch (source) {
        case 'dsh': return 'DSH'
        case 'codex': return 'Codex'
        case 'claude': return 'Claude Code'
        case 'claude-desktop': return 'Claude Desktop'
        case 'cursor': return 'Cursor'
        case 'gemini': return 'Gemini'
        case 'project': return 'Project'
        default: return source
      }
    }

    function candidateKey(candidate) {
      return `${candidate.source}:${candidate.name}:${candidate.path}`
    }

    function describeServiceResult(op, result, t) {
      if (result === undefined) return t.none
      if (result.ok === false) return `${t.error}: ${result.error ?? result.reason ?? ''}`
      if (op === 'stop') return result.stopped === true ? t.ok : (result.reason ?? t.none)
      if (result.adopted === true) return `${t.adopted}`
      return `${t.ok}${result.tools === undefined ? '' : ` · ${result.tools.length} ${t.tools}`}`
    }

    // ── 侧栏页（dsh-better-sidebar） ────────────────────────────────────────
    /**
     * 侧栏页组件。
     *
     * 与卡片共用同一个后端 /api/penpot/*，但排版为竖直窄栏，只保留最常用的
     * 三件事：看状态、跑探测、看日志尾部。
     *
     * @param {{ ctx: any, store: any, scope: any, tab: any, visible: boolean }} props
     */
    function PenpotSidebarView(props) {
      const t = pickTexts(props.ctx)
      const { status, config, error, reload } = useStatus(props.visible === false ? 0 : 5000)
      const [busy, setBusy] = React.useState('')
      const [probe, setProbe] = React.useState(undefined)
      const [logs, setLogs] = React.useState(undefined)
      const [message, setMessage] = React.useState(undefined)

      const act = React.useCallback(async (label, fn) => {
        setBusy(label)
        setMessage(undefined)
        try {
          await fn()
          await reload()
        } catch (err) {
          setMessage(String(err?.message ?? err))
        } finally {
          setBusy('')
        }
      }, [reload])

      return h('div', { className: 'pnp-side' }, [
        h('div', { className: 'pnp-head', key: 'h' }, [
          h('p', { className: 'pnp-title', key: 't' }, t.sidebarTitle),
          h(StatusDot, {
            key: 's',
            state: status?.state,
            label: status === undefined ? '—' : (t[`state_${status.state}`] ?? status.state),
          }),
        ]),
        error === undefined ? null : h(Message, { key: 'e', kind: 'bad', text: error }),
        message === undefined ? null : h(Message, { key: 'm', kind: 'bad', text: message }),

        status === undefined
          ? h('p', { className: 'pnp-hint', key: 'l' }, t.sidebarEmpty)
          : h('div', { className: 'pnp-chans', key: 'chan' }, [
            h(Channel, {
              key: 'mcp',
              name: 'MCP',
              ok: status.channels?.mcp?.usable === true,
              warn: status.channels?.mcp?.stage === 'no-instance',
              state: status.channels?.mcp?.label ?? '—',
              note: t.chanNeedsTab,
              desc: t.chanMcpDesc,
            }),
            h(Channel, {
              key: 'rest',
              name: 'REST',
              ok: status.channels?.rest?.usable === true,
              warn: status.channels?.rest?.configured === true,
              state: status.channels?.rest?.usable === true ? t.chanOk : restLabel(status.channels?.rest?.stage, t),
              note: t.chanNoTab,
              desc: t.chanRestDesc,
            }),
          ]),

        status === undefined ? null : h('dl', { className: 'pnp-rows', key: 'g' }, [
          h(Row, { key: 'r1', label: t.mode }, modeLabel(status.mode, t)),
          h(Row, { key: 'r2', label: t.tools }, String(status.toolCount ?? 0)),
        ]),

        h('div', { className: 'pnp-actions', key: 'a' }, [
          h(Button, { key: 's', primary: true, disabled: busy !== '', onClick: () => act('start', () => callApi('service', { op: 'start' })) }, t.start),
          h(Button, { key: 'p', disabled: busy !== '', onClick: () => act('probe', async () => setProbe(await callApi('service', { op: 'probe' }))) }, busy === 'probe' ? t.probing : t.probe),
          h(Button, { key: 'l', quiet: true, disabled: busy !== '', onClick: () => act('logs', async () => setLogs((await callApi('logs?lines=40')).text)) }, t.logs),
        ]),
        logs === undefined ? null : h('pre', { className: 'pnp-pre', key: 'logs' }, logs === '' ? t.none : logs),
        config?.detected?.from ? h('p', { className: 'pnp-hint', key: 'd' }, `${t.detectedFrom}: ${config.detected.from}`) : null,
      ])
    }

    // ── 挂载 ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      ensureStyle()
      const t = pickTexts(ctx)

      // 1) 插件页配置卡片
      const mountCard = scoped => {
        const slots = scoped?.slots
        if (slots === undefined || typeof slots.register !== 'function') return undefined
        return scoped.slots.inject('plugins.bundle.config', () => scoped.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-plugin-penpot',
            inject: () => ({ t }),
          },
          PenpotCard,
        ))
      }
      if (typeof ctx.inject === 'function') {
        ctx.effect(() => ctx.inject(['slots'], scoped => mountCard(scoped)), 'penpot: plugin page card')
      } else {
        try { mountCard(ctx) } catch { /* CLI 客户端没有 slots，跳过 */ }
      }

      // 2) 侧栏页（装了 dsh-better-sidebar 才有）
      const mountTab = scoped => {
        const sidebar = (() => {
          try { return scoped.get?.('betterSidebar') ?? scoped.betterSidebar } catch { return undefined }
        })()
        if (sidebar === undefined || typeof sidebar.registerTab !== 'function') return undefined
        return sidebar.registerTab({
          id: 'penpot:dashboard',
          title: 'Penpot',
          description: 'Penpot MCP 的连接状态、探测结论与日志。',
          order: 60,
          single: true,
          component: PenpotSidebarView,
        })
      }
      if (typeof ctx.inject === 'function') {
        ctx.effect(() => ctx.inject(['betterSidebar'], scoped => mountTab(scoped)), 'penpot: sidebar tab')
      }
    }

    exports.apply = apply
    exports.inject = []
    exports.version = VERSION
    return module.exports
  },
})