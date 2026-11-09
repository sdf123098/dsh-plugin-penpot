/**
 * 配置：字段定义、默认值、校验与归一。
 *
 * 用纯 JS 手写而不是 schemastery：本插件的设置界面是自己在插件页注册的卡片
 * （`plugins.bundle.config` 槽），不需要宿主按 schema 自动生成，因此少一层依赖、
 * 也便于单测。非法值在加载期回落默认，绝不让插件起不来。
 *
 * 三个连接档 + 一个自动档（mode: auto）：
 *   - official : Penpot 官方托管（design.penpot.app），凭据是 MCP key（URL 的 userToken）
 *   - local    : 本机跑 MCP 服务器（现有仓库 dist，或 npx @penpot/mcp）
 *   - selfhost : 自己部署的 Penpot 实例，协议与 official 相同
 *   - auto     : 首启扫描本机已有 penpot 配置，用扫到的那条当默认（见 detect.js）
 *
 * @module dsh-plugin-penpot/config
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** 四个连接档。 */
export const MODES = ['auto', 'official', 'local', 'selfhost']

/** 两种启动方式。 */
export const STARTUPS = ['auto', 'lazy']

/** 本地档的两个子选项。 */
export const LOCAL_SUBS = ['repo', 'npm']

/** 远端传输。Penpot 官方两个端点都实现了：/mcp/stream（主）与 /mcp/sse（备）。 */
export const TRANSPORTS = ['http', 'sse']

/** 插件 UI（4400 那个 manifest）的三种托管方式 —— 只对 local 档有意义。 */
export const PLUGIN_HOSTING = ['bundled', 'port', 'external']

/**
 * 0.1.0 里的旧值 → 新值。
 *
 * `dsh` 当时其实没实现（DSH 那边根本没有 `/penpot-plugin` 静态路由），
 * 落到最后那个分支 = 「你自己托管」。现在这一段被真正做出来了，
 * 旧值一律按 `bundled` 解释 —— 否则升级后用户会莫名其妙要求自己起服务。
 */
const HOSTING_ALIASES = { dsh: 'bundled' }

/** 官方托管端点。 */
export const OFFICIAL_ENDPOINT = 'https://design.penpot.app/mcp/stream'

/** 官方 beta 端点。 */
export const OFFICIAL_BETA_ENDPOINT = 'https://test-mcp.penpot.dev/mcp/stream'

/**
 * 本地仓库的默认猜测位置。
 *
 * 这里**不能写死某个用户的绝对路径** —— 打包发布之后那台机器上根本没有
 * `C:\Users\<某人>\...`，写死只会让别人看到一条指向不存在的路径的默认值。
 * 改成按当前用户的 HOME 推：`<home>/.dsh/mcp-servers/penpot`，
 * 正好是 `git clone` 到 DSH 数据目录下的常见位置。
 */
function defaultRepoDir() {
  try {
    return join(homedir(), '.dsh', 'mcp-servers', 'penpot')
  } catch {
    return ''
  }
}

/** 本地仓库的默认位置（按当前用户推，不写死绝对路径）。 */
export const DEFAULT_REPO_DIR = defaultRepoDir()

/** 本地档默认入口（相对 repoDir，cwd 必须是它的上级 packages/server）。 */
export const DEFAULT_LOCAL_ENTRY = 'packages/server/dist/index.js'

/** 本地服务器默认端口。 */
export const DEFAULT_PORTS = {
  http: 4401,
  ws: 4402,
  repl: 4403,
  /** 插件 UI（manifest.json）的静态托管端口，官方默认 4400。 */
  plugin: 4400,
}

/**
 * 部署级默认值。patch 行的 `config` 覆盖同名项，设置页写入的覆盖项再盖一层。
 */
export const DEFAULTS = {
  /** auto = 首启按本机 MCP 配置判定。 */
  mode: 'auto',
  /** lazy = 首次用到才启动/建连，之后常驻。 */
  startup: 'lazy',
  /** execute_code / import_image 走 DSH 审批。 */
  requireApproval: true,
  /** 注册 penpot_control（start/stop/restart/probe/detect/logs）。 */
  exposeControlTool: true,
  /** 单次上游调用超时。execute_code 里跑大段代码可能慢，给足 3 分钟。 */
  toolCallTimeoutMs: 180_000,
  /** 建连/推进超时。 */
  connectTimeoutMs: 60_000,
  /** 空闲多久自动停本地进程（分钟）；0 = 不停（默认，符合"唤醒后一直启动"）。 */
  idleStopMinutes: 0,

  official: {
    endpoint: OFFICIAL_ENDPOINT,
    /** 粘贴 Integrations 里复制的完整 URL（含 userToken）；拆出来的 token 单独存。 */
    token: '',
    transport: 'http',
  },

  local: {
    /** repo = 跑本地仓库的 dist；npm = npx @penpot/mcp。 */
    sub: 'repo',
    repoDir: DEFAULT_REPO_DIR,
    entry: DEFAULT_LOCAL_ENTRY,
    /** 留空则自动找 node.exe。 */
    nodePath: '',
    /** npm 子选项用的 tag 或版本号。 */
    npmTag: 'stable',
    /** dist 缺失时自动跑一次 pnpm run build（默认关，构建可能几分钟）。 */
    autoBuild: false,
    host: '127.0.0.1',
    httpPort: DEFAULT_PORTS.http,
    wsPort: DEFAULT_PORTS.ws,
    replPort: DEFAULT_PORTS.repl,
    logLevel: 'info',
    /**
     * 插件 UI（manifest.json）由谁托管：
     *   - `bundled`  ：插件自己起一个静态服务（默认，端口 local.pluginPort）
     *   - `port`     ：交给 MCP 服务器的 4400（官方 `pnpm run bootstrap` 那套）
     *   - `external` ：你自己起，插件只显示该填的 URL
     */
    pluginHosting: 'bundled',
    /** pluginHosting=bundled 时监听的端口。 */
    pluginPort: DEFAULT_PORTS.plugin,
    /** 额外环境变量（键值对），给 dist 或 npx 用。 */
    env: {},
  },

  selfhost: {
    /** 完整 MCP URL，含 userToken（从自己实例的 Integrations 复制）。 */
    url: '',
    token: '',
    transport: 'http',
    /** 自签证书场景。 */
    allowInsecureTLS: false,
  },

  /**
   * 个人访问令牌（PAT）只读通道，见 rest.js。
   *
   * 为什么它和 MCP key 分开存：两者走**不同的 HTTP 通道、不同的认证头**
   * （MCP 认 URL 的 userToken，REST 认 `Authorization: Token`），生命周期也不同
   * （PAT 可以是无期限的，MCP key 有到期日）。合并存会在换 key 时把 PAT 一起弄丢。
   */
  pat: {
    /** 令牌本身。留空 = 不用这条通道；留空时回落去借 MCP key（实测同一个值两边都认）。 */
    token: '',
    /** 借用 MCP key 当 PAT 用（默认开：Integrations 那个 key 本来就是有效 PAT）。 */
    reuseMcpKey: true,
  },

  /**
   * 无人值守时自己拉起浏览器（见 browser.js）。
   *
   * 只用于「需要 MCP 通道、但没人在旁边开网页」的场景。注意两件事：
   *   1. 用**独立 profile**，和用户的默认浏览器完全隔离 —— 不碰他的 Zen / Chrome
   *   2. 只有 Chromium 系（Chrome / Edge / Brave）能驱动；Zen 是 Firefox 内核，没有 CDP
   *
   * 更要紧的是：**大部分自动化根本不需要它** —— design.js 的 REST 写通道
   * 建文件、加图层、改属性、删图层全都能做，零浏览器。
   */
  browser: {
    /** 允许插件自己起浏览器。默认关：这是「替用户开程序」，该由他决定。 */
    autoLaunch: false,
    /** 浏览器可执行文件路径；留空自动找 Chrome / Edge / Brave。 */
    path: '',
    /** 无头模式（首次登录时必须关，不然没法输入账号密码）。 */
    headless: false,
    /** 启动后等调试端口就绪的上限。 */
    launchTimeoutMs: 20_000,
  },

  /**
   * 自动判定的结果。由 detect.js 写入，用户手动改过档位后 mode 变 manual
   * （见 store.js 的 EDITABLE / applyPatch），此后不再自动改。
   */
  detected: {
    picked: '',
    from: '',
    rationale: '',
    pickedAt: '',
  },
}

/** 可以写进覆盖文件的顶层键。 */
export const EDITABLE_TOP = [
  'mode',
  'startup',
  'requireApproval',
  'exposeControlTool',
  'toolCallTimeoutMs',
  'connectTimeoutMs',
  'idleStopMinutes',
]

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function pickEnum(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

/** 和 pickEnum 一样，但先过一遍别名表（只有 pluginHosting 用）。 */
function pickHosting(value, fallback) {
  const normalized = typeof value === 'string' && HOSTING_ALIASES[value] !== undefined ? HOSTING_ALIASES[value] : value
  return pickEnum(normalized, PLUGIN_HOSTING, fallback)
}

function pickString(value, fallback) {
  return typeof value === 'string' ? value : fallback
}

function pickBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

function pickPort(value, fallback) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(number) || number < 1 || number > 65_535) return fallback
  return number
}

function pickMillis(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * 把「URL 里的 userToken」拆出来，变成「干净 URL + 独立 token」。
 *
 * ## 为什么必须在配置层做这件事
 *
 * token 原来只活在端点的 URL 里（`…?userToken=xxx`），而面板上的端点输入框
 * 必须脱敏 —— 两者直接打架：输入框显示的是去掉 token 的地址，用户一点保存
 * 就把带 token 的地址覆盖成不带 token 的，**key 当场消失**。
 *
 * 这个 bug 真的发生了两次。第一版护栏只拦住了 `userToken=***` 那种，
 * 拦不住「被摘干净之后提交上来的干净 URL」—— 因为那时候字符串里连 `***`
 * 都没有了，护栏无从判断。
 *
 * 根治办法是不让它处于「只能二选一」的形态：**URL 只存地址，token 单独存**。
 * 连接时用 `mcp-client.withToken()` 拼回去。这样面板可以安心回显干净地址，
 * 用户编辑地址也不会碰到凭据。
 *
 * 兼容三种历史形态：
 *   - 老的：token 在 URL 里，`.token` 为空      → 拆出来
 *   - 新的：URL 干净，`.token` 有值             → 原样
 *   - 两者都有（迁移中间态）                    → 显式 `.token` 赢
 *
 * @param {string} url
 * @param {string} explicit
 * @returns {{ url: string, token: string }}
 */
export function splitUserToken(url, explicit) {
  const token = typeof explicit === 'string' ? explicit : ''
  const raw = typeof url === 'string' ? url : ''
  if (raw === '') return { url: '', token }
  let fromUrl = ''
  let clean = raw
  try {
    const parsed = new URL(raw)
    fromUrl = parsed.searchParams.get('userToken') ?? ''
    if (fromUrl !== '') {
      parsed.searchParams.delete('userToken')
      clean = parsed.toString()
    }
  } catch {
    const match = /([?&])userToken=([^&]*)/i.exec(raw)
    if (match !== null) {
      fromUrl = (() => { try { return decodeURIComponent(match[2]) } catch { return match[2] } })()
      clean = raw
        .replace(/([?&])userToken=[^&]*&?/i, (whole, sep) => (sep === '?' && whole.endsWith('&') ? '?' : ''))
        .replace(/[?&]$/, '')
    }
  }
  return { url: clean, token: token !== '' ? token : fromUrl }
}

/**
 * 把任意来源（默认值 ← patch ← 用户覆盖）合并后的原始对象归一成可信配置。
 *
 * 每一层都做同样的归一，所以「patch 里写错一个枚举」只影响那一项，其余照常。
 *
 * @param {Record<string, unknown> | undefined} raw
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw) {
  const source = isPlainObject(raw) ? raw : {}
  const official = isPlainObject(source.official) ? source.official : {}
  const local = isPlainObject(source.local) ? source.local : {}
  const selfhost = isPlainObject(source.selfhost) ? source.selfhost : {}
  const pat = isPlainObject(source.pat) ? source.pat : {}
  const browser = isPlainObject(source.browser) ? source.browser : {}
  const detected = isPlainObject(source.detected) ? source.detected : {}

  const env = {}
  if (isPlainObject(local.env)) {
    for (const [key, value] of Object.entries(local.env)) {
      if (typeof key === 'string' && key !== '' && (typeof value === 'string' || typeof value === 'number')) {
        env[key] = String(value)
      }
    }
  }

  return {
    mode: pickEnum(source.mode, MODES, DEFAULTS.mode),
    startup: pickEnum(source.startup, STARTUPS, DEFAULTS.startup),
    requireApproval: pickBool(source.requireApproval, DEFAULTS.requireApproval),
    exposeControlTool: pickBool(source.exposeControlTool, DEFAULTS.exposeControlTool),
    toolCallTimeoutMs: pickMillis(source.toolCallTimeoutMs, DEFAULTS.toolCallTimeoutMs, 5_000, 30 * 60_000),
    connectTimeoutMs: pickMillis(source.connectTimeoutMs, DEFAULTS.connectTimeoutMs, 2_000, 10 * 60_000),
    idleStopMinutes: pickMillis(source.idleStopMinutes, DEFAULTS.idleStopMinutes, 0, 24 * 60),

    official: (() => {
      const split = splitUserToken(
        pickString(official.endpoint, DEFAULTS.official.endpoint),
        pickString(official.token, DEFAULTS.official.token),
      )
      return {
        endpoint: split.url,
        token: split.token,
        transport: pickEnum(official.transport, TRANSPORTS, DEFAULTS.official.transport),
      }
    })(),

    local: {
      sub: pickEnum(local.sub, LOCAL_SUBS, DEFAULTS.local.sub),
      repoDir: pickString(local.repoDir, DEFAULTS.local.repoDir),
      entry: pickString(local.entry, DEFAULTS.local.entry),
      nodePath: pickString(local.nodePath, DEFAULTS.local.nodePath),
      npmTag: pickString(local.npmTag, DEFAULTS.local.npmTag),
      autoBuild: pickBool(local.autoBuild, DEFAULTS.local.autoBuild),
      host: pickString(local.host, DEFAULTS.local.host),
      httpPort: pickPort(local.httpPort, DEFAULTS.local.httpPort),
      wsPort: pickPort(local.wsPort, DEFAULTS.local.wsPort),
      replPort: pickPort(local.replPort, DEFAULTS.local.replPort),
      logLevel: pickString(local.logLevel, DEFAULTS.local.logLevel),
      pluginHosting: pickHosting(local.pluginHosting, DEFAULTS.local.pluginHosting),
      pluginPort: pickPort(local.pluginPort, DEFAULTS.local.pluginPort),
      env,
    },

    selfhost: (() => {
      const split = splitUserToken(
        pickString(selfhost.url, DEFAULTS.selfhost.url),
        pickString(selfhost.token, DEFAULTS.selfhost.token),
      )
      return {
        url: split.url,
        token: split.token,
        transport: pickEnum(selfhost.transport, TRANSPORTS, DEFAULTS.selfhost.transport),
        allowInsecureTLS: pickBool(selfhost.allowInsecureTLS, DEFAULTS.selfhost.allowInsecureTLS),
      }
    })(),

    pat: {
      token: pickString(pat.token, DEFAULTS.pat.token),
      reuseMcpKey: pickBool(pat.reuseMcpKey, DEFAULTS.pat.reuseMcpKey),
    },

    browser: {
      autoLaunch: pickBool(browser.autoLaunch, DEFAULTS.browser.autoLaunch),
      path: pickString(browser.path, DEFAULTS.browser.path),
      headless: pickBool(browser.headless, DEFAULTS.browser.headless),
      launchTimeoutMs: pickMillis(browser.launchTimeoutMs, DEFAULTS.browser.launchTimeoutMs, 3_000, 120_000),
    },

    detected: {
      picked: pickString(detected.picked, ''),
      from: pickString(detected.from, ''),
      rationale: pickString(detected.rationale, ''),
      pickedAt: pickString(detected.pickedAt, ''),
    },
  }
}

/**
 * 三层合并：内置默认 ← patch 行的部署配置 ← 设置页写入的用户覆盖。
 *
 * 深层合并（official/local/selfhost/detected 各并一次），否则用户在面板里只改
 * 一个端口就会把整块 local 配置抹掉。
 *
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown> | undefined} deploy patch 行里的 config
 * @param {Record<string, unknown>} overrides 设置页写入的
 * @returns {Record<string, unknown>}
 */
export function mergeConfig(defaults, deploy, overrides) {
  const merge = (base, layer) => {
    const out = { ...base }
    for (const [key, value] of Object.entries(isPlainObject(layer) ? layer : {})) {
      if (value === undefined) continue
      if (!(key in base)) continue
      if (isPlainObject(base[key]) && isPlainObject(value)) out[key] = merge(base[key], value)
      else out[key] = value
    }
    return out
  }
  return resolveConfig(merge(merge(defaults, deploy), overrides))
}

/**
 * 当前档位实际用哪个远端 URL 与 token。
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {{ kind: 'official' | 'selfhost', url: string, token: string, transport: string, allowInsecureTLS: boolean } | { kind: 'local', repoDir: string, entry: string, nodePath: string, host: string, httpPort: number, wsPort: number, replPort: number, url: string, transport: 'http', token: '', allowInsecureTLS: false }}
 */
export function resolveTarget(config) {
  const mode = config.mode === 'auto' ? (config.detected.picked || 'local') : config.mode
  if (mode === 'local') {
    const local = config.local
    return {
      kind: 'local',
      repoDir: local.repoDir,
      entry: local.entry,
      nodePath: local.nodePath,
      host: local.host,
      httpPort: local.httpPort,
      wsPort: local.wsPort,
      replPort: local.replPort,
      url: `http://${local.host}:${local.httpPort}/mcp`,
      transport: 'http',
      token: '',
      allowInsecureTLS: false,
    }
  }
  const block = mode === 'selfhost' ? config.selfhost : config.official
  return {
    kind: mode === 'selfhost' ? 'selfhost' : 'official',
    url: block.endpoint ?? block.url ?? '',
    token: block.token ?? '',
    transport: block.transport ?? 'http',
    allowInsecureTLS: block.allowInsecureTLS === true,
  }
}
