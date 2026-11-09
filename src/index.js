/**
 * 插件入口（host 半）。
 *
 * 挂载顺序有讲究：
 *   1. 先建服务与配置（不 await —— 首启扫描要 1~2 秒，不能让 DSH 卡住）
 *   2. 注册工具时还不知道能不能连上，工具内部 lazy 处理（penpot_status 说明原因）
 *   3. webServer 是**可选**的：纯 CLI profile 里没有它，插件应当照常激活
 *   4. betterSidebar 也是可选的：没装 dsh-better-sidebar 就只做插件页卡片
 *
 * 自动判定（mode: auto）在首次加载时异步跑一次，结果写进 detected.json；
 * 用户在面板里手动改过档位后 mode 变 manual，之后不再自动改。
 *
 * @module dsh-plugin-penpot
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { DEFAULT_PORTS, DEFAULTS, resolveConfig } from './config.js'
import { PenpotService } from './service.js'
import { registerTools } from './tools.js'
import { installApprovalGate } from './approval.js'
import { makeRoute } from './routes.js'
import { decideAuto } from './detect.js'
import { applyMigration, backups, planScan, restoreBackup } from './migrate.js'
import { readDetected, readOverrides, writeDetected, writeOverrides, guardPatch, keepCredentials, normalizeCredentials } from './store.js'

/** Cordis 插件名。 */
export const name = 'penpot'

/**
 * 必需服务：只有工具注册表。
 *
 * `webServer` / `betterSidebar` / `attachments` 都**不**写进 inject：
 * 缺任意一个就让整棵插件树挂掉不值得，各自在 apply 里按需注入。
 */
export const inject = ['tools']

/** 从 package.json 读版本，避免面板显示和实际装的不一致。 */
function readVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    return String(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')).version)
  } catch {
    return '0.0.0-unknown'
  }
}

const VERSION = readVersion()

/** 模型侧公告：只写「这插件存在 + 什么时候找它」，不写实现细节。 */
const GUIDANCE = [
  '本机已安装 dsh-plugin-penpot（Penpot MCP 集成）：把 Penpot 的 MCP 服务器接进 DSH。'
  + '连接目标三档——官方托管（design.penpot.app，凭据是 Penpot Integrations 里生成的 MCP key，作为 URL 的 userToken 查询参数）、'
  + '本地自构建（本机跑 packages/server/dist/index.js 或 npx @penpot/mcp，额外多一个 import_image）、'
  + '自部署（自己服务器上的 Penpot，协议同官方）；默认档是「自动识别」：首次加载时扫描本机已有的 penpot MCP 配置（DSH profile / Codex / Claude / Cursor / Gemini / 项目级 .mcp.json），用扫到的那条当默认，并在面板标出来源。'
  + '启动方式：auto（加载即启动）/ lazy（首次调用才启动，之后常驻不随回合结束释放）。'
  + 'Penpot 没有 OAuth —— 服务端不校验 key 本身、也不认 Authorization 头，只拿 URL 里的 userToken 去索引「已连上来的那个 Penpot 标签页」，'
  + '所以「连不通」只能靠 execute_code 的报错文本分级：端点可达 / 缺 MCP key / Penpot 未点 Connect / 已打通。'
  + '另有个人访问令牌（PAT）只读通道（工具 penpot_read）：走 REST 的 Authorization: Token 头，**不需要 Penpot 标签页在线**也能读团队 / 项目 / 文件 / 页面结构，'
  + '还能离线验证凭据是否有效（MCP 通道做不到这件事，它对任何 key 都返回 200）；Integrations 里那个 MCP key 本身就是有效 PAT，不必另建。'
  + '只想读设计数据、不执行代码时优先用 penpot_read。'
  + '面板在侧边栏「插件」→ dsh-plugin-penpot（默认展开），另有 /api/penpot/* 与可选的侧栏标签页。'
  + '用户提到「Penpot / 设计稿 / 原型 / 导出图形 / penpot 插件」时用本插件的工具；'
  + '连不上先调 penpot_status，它给出的是诊断结论而不是业务结果。',
  'The dsh-plugin-penpot plugin is installed: it brings the Penpot MCP server into DSH. '
  + 'Three connection targets — official hosted (design.penpot.app; the credential is an MCP key generated in Penpot Integrations, carried as the URL userToken query parameter), '
  + 'local build (run packages/server/dist/index.js or npx @penpot/mcp on this machine; adds import_image), '
  + 'and self-hosted (your own Penpot server, same protocol as official). The default target is auto-detect: on first load it scans the penpot MCP entries you already have (DSH profile / Codex / Claude / Cursor / Gemini / project .mcp.json), adopts the one it finds, and shows the provenance in the panel. '
  + 'Startup is auto (start on load) or lazy (start on first call, then stay resident across turns). '
  + 'Penpot has no OAuth: the server does not validate the key itself and ignores the Authorization header — it only maps the URL userToken to an already-connected Penpot tab, '
  + 'so failures are graded from the execute_code error text: endpoint reachable / missing MCP key / Penpot not connected / fully working. '
  + 'There is also a personal-access-token (PAT) read-only channel (tool penpot_read): it uses the REST Authorization: Token header and needs NO live Penpot tab, '
  + 'reading teams / projects / files / page structure, and it can verify a credential offline (something the MCP channel cannot do — it answers 200 to any key); '
  + 'the MCP key from Integrations is itself a valid PAT. Prefer penpot_read when you only need to read design data. '
  + 'The panel lives under sidebar → 插件 → dsh-plugin-penpot (expanded by default), plus /api/penpot/* routes and an optional sidebar tab. '
  + 'When the user mentions Penpot, design files, prototypes or exporting shapes, use these tools; if it is not responding, call penpot_status first — it answers with a diagnosis.',
].join('\n\n')

/** 公告在工具提示带里的位置。 */
const SECTION_ORDER = 158

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const log = (message) => {
    try { ctx.logger?.info?.(`[penpot] ${message}`) } catch { /* ignore */ }
  }
  const warn = (message) => {
    try { ctx.logger?.warn?.(`[penpot] ${message}`) } catch { /* ignore */ }
  }

  // 三层配置：内置默认 ← patch 行的部署配置 ← 设置页写入的用户覆盖。
  const deploy = rawConfig ?? {}
  const service = new PenpotService({ log })
  service.refreshConfig(deploy)

  // 自动判定的结果优先于 patch 里的 mode（detected.picked 是这台机器的实情）
  const applyDetected = (result) => {
    if (result === undefined) return service.config
    writeDetected(result)
    // 把判定写进「用户覆盖层」的 detected 段：不碰 patch 文件，也不改 mode
    // （mode 保持 auto，这样下次还会重新判定；用户手动改档才变具体档）
    writeOverrides({ detected: { picked: result.picked, from: result.from, rationale: result.rationale, pickedAt: result.pickedAt } })
    service.refreshConfig(deploy)
    return service.config
  }

  const runDetect = async () => {
    const result = await decideAuto({ config: service.config })
    applyDetected(result)
    log(`自动识别：${result.picked} ← ${result.from}`)
    return result
  }

  // ── 工具注册 ───────────────────────────────────────────────────────────────
  // penpot_control 的 detect 操作需要读到这个钩子（避免 tools.js 反向依赖 detect）
  ctx.provide('penpotDetect', runDetect)

  const registered = registerTools({ ctx, service })
  log(`已注册 ${registered.length} 个工具：${registered.join(', ')}`)

  // ── 审批闸门 ───────────────────────────────────────────────────────────────
  ctx.effect(
    () => installApprovalGate(ctx, { requireApproval: service.config.requireApproval, log }),
    'penpot: approval gate',
  )

  // ── 自动判定（首启） ───────────────────────────────────────────────────────
  ctx.effect(() => {
    let disposed = false
    void (async () => {
      // 已判定过且用户没切档，就用上次结果（省掉一次 2 秒扫描）
      const stored = readDetected()
      const overrides = readOverrides()
      if (service.config.mode === 'auto' && stored.picked !== undefined && stored.picked !== ''
        && overrides.mode === undefined) {
        service.refreshConfig(deploy)
        log(`沿用上次自动判定：${stored.picked} ← ${stored.from}`)
      } else if (service.config.mode === 'auto') {
        try {
          const result = await runDetect()
          if (disposed) return
          log(`自动判定完成：${result.picked}（${result.offline ? '离线' : '可达'}）`)
        } catch (error) {
          warn(`自动判定失败（不影响手动配置）：${String(error?.message ?? error)}`)
        }
      }
      if (disposed) return
      // startup=auto 才在加载后自动拉起；lazy 等到首次调用
      if (service.config.startup === 'auto') {
        const ready = await service.ensureReady().catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
        if (disposed) return
        if (ready.ok) log(`已自动连接：${service.snapshot().endpoint}`)
        else warn(`自动连接失败（首次调用时会重试）：${ready.error}`)
      }
    })()
    return () => { disposed = true }
  }, 'penpot: initial detect + connect')

  // ── 自动检测（独立于「服务开没开」） ───────────────────────────────────────
  //
  // 为什么要单独一段：REST 通道（PAT / MCP key 走 Authorization: Token）
  // **根本不需要 MCP 服务** —— 它就是一个带 Token 头的 HTTP POST。
  // 让它跟着 MCP 的启停走，lazy 档下就永远不检测，面板一直显示「未启动」，
  // 用户既不知道令牌行不行，也不知道端点通不通。
  //
  // 这段只做一件事：隔一段时间验一次 REST 通道。不建 MCP 连接、不拉进程。
  ctx.effect(() => {
    let disposed = false
    const tick = async () => {
      if (disposed) return
      try {
        await service.autoCheck({ maxAgeMs: 60_000 })
      } catch (error) {
        warn(`自动检测失败（不影响手动配置）：${String(error?.message ?? error)}`)
      }
    }
    // 首次稍等一下，别和自动判定抢同一段启动时间
    const warm = setTimeout(() => { void tick() }, 1_200)
    const timer = setInterval(() => { void tick() }, 120_000)
    // 定时器必须 unref：不能因为一个自检把 DSH 进程吊着不退
    warm.unref?.()
    timer.unref?.()
    return () => {
      disposed = true
      clearTimeout(warm)
      clearInterval(timer)
    }
  }, 'penpot: rest auto-check')

  // ── 空闲停止（默认关；开了才装定时器） ─────────────────────────────────────
  ctx.effect(() => {
    const minutes = service.config.idleStopMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) return () => {}
    const timer = setInterval(() => {
      void (async () => {
        const snapshot = service.snapshot()
        if (snapshot.state !== 'running') return
        // 只有本地档有进程可停；远端只断连，不值得定时处理
        if (service.effectiveMode() !== 'local') return
        if (Date.now() - snapshot.lastUsedAt < minutes * 60_000) return
        log(`空闲超过 ${minutes} 分钟，停止本地进程`)
        await service.stop()
      })()
    }, Math.max(60_000, minutes * 30_000))
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'penpot: idle stop')

  // ── /api/penpot/* 路由（webServer 可选） ───────────────────────────────────
  ctx.effect(() => {
    const mount = (scoped) => {
      const webServer = scoped?.webServer
      if (webServer === undefined || typeof webServer.register !== 'function') return undefined
      const route = makeRoute({
        service,
        readConnection: () => {
          try { return scoped.get?.('connection') ?? ctx.get?.('connection') } catch { return undefined }
        },
        log,
        hooks: {
          detect: runDetect,
          applyDetected: async () => {
            const stored = readDetected()
            return { detected: stored }
          },
          migrateScan: () => planScan({ cwd: process.cwd() }),
          migrateApply: async (entries) => {
            const result = applyMigration({ entries })
            if (result.ok !== true) return result
            const saved = writeOverrides(result.configPatch)
            if (saved.ok !== true) return { ok: false, error: saved.error }
            service.refreshConfig(deploy)
            // 导入完重新建连，让新档位立刻生效
            if (service.snapshot().hasSession) void service.restart().catch(() => {})
            return result
          },
          migrateRestore: async (dir) => restoreBackup(dir),
          migrateBackups: () => backups(),
          pluginManifest: () => describePluginManifest(service.config, service.pluginHostInfo()),
          saveConfig: async (patch) => {
            // 两道护栏，针对两次真实事故：
            //  1. guardPatch —— 挡住脱敏占位符（`userToken=***`）被写回磁盘
            //  2. keepCredentials —— 挡住「面板没提交 token 就把库里的 token 抹掉」
            // 第二条是根治：端点输入框只能显示干净地址，不补回就等于每次保存都丢凭据。
            const guarded = guardPatch(patch)
            const withCreds = keepCredentials(guarded.patch, readOverrides())
            // 落盘形态只有一种：endpoint 干净 + token 单独存。
            // 否则「用户把完整地址粘进端点框」会存下两种形态，读的时候到处判断。
            const next = { ...normalizeCredentials(withCreds.patch) }
            // mode 被手动改动 → 记成具体档（auto 之外的档），不再自动覆盖
            if (typeof next.mode === 'string' && next.mode !== 'auto') {
              next.detected = undefined
            }
            const saved = writeOverrides(next)
            if (saved.ok !== true) throw new Error(saved.error)
            service.refreshConfig(deploy)
            return {
              config: service.publicConfig(),
              overrides: saved.overrides,
              dropped: guarded.dropped,
              kept: withCreds.kept,
            }
          },
        },
      })
      return webServer.register(route)
    }
    if (typeof ctx.inject === 'function') {
      return ctx.inject(['webServer'], (scoped) => mount(scoped))
    }
    try {
      return mount(ctx)
    } catch {
      return undefined
    }
  }, 'penpot: /api/penpot routes')

  // ── 侧栏标签页 ─────────────────────────────────────────────────────────────
  // betterSidebar 是**浏览器侧**服务（客户端半在浏览器里 ctx.provide('betterSidebar')），
  // 宿主这里拿不到、也不该拿。侧栏页由 lib/client.js 在浏览器里注册，
  // 它自己 inject('betterSidebar') 后调 registerTab。这里只留一行说明。
  log('侧栏页（若装了 dsh-better-sidebar）由客户端半注册')

  // ── 系统提示公告 ───────────────────────────────────────────────────────────
  ctx.effect(() => {
    const systemPrompt = (() => {
      try { return ctx.get?.('systemPrompt') } catch { return undefined }
    })()
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') return () => {}
    return systemPrompt.section({ name: 'plugin:dsh-plugin-penpot', order: SECTION_ORDER, text: GUIDANCE })
  }, 'penpot: guidance')

  // ── 卸载清理 ───────────────────────────────────────────────────────────────
  ctx.effect(() => () => {
    // 只断连接，**不杀本地进程**：它是独立服务，DSH 重启后还要接管它。
    void service.disconnect().catch(() => {})
  }, 'penpot: cleanup')

  log(`host ready (${VERSION}) — mode=${service.config.mode} startup=${service.config.startup}`)
}

/**
 * 本地档插件 UI（manifest.json）现在该用什么地址。
 *
 * 这一段最容易让用户卡住：MCP 服务器起来了、探测说「Penpot 未连上来」，
 * 但他不知道该在 Penpot 里填什么。所以三种托管方式都要给出**具体地址**，
 * 而不是一句「你自己去构建」。地址来自 service 的实况（服务可能真起着，
 * 也可能起失败 —— 后者要把原因说出来）。
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {ReturnType<import('./service.js').PenpotService['pluginHostInfo']>} [hostInfo]
 */
function describePluginManifest(config, hostInfo) {
  const mode = config.mode === 'auto' ? (config.detected.picked || 'local') : config.mode
  if (mode !== 'local') {
    return {
      needed: false,
      reason: '官方托管 / 自部署不需要本地插件：在 Penpot 里用 File → MCP Server → Connect。',
    }
  }
  const local = config.local
  const info = hostInfo ?? {
    hosting: local.pluginHosting,
    url: '',
    running: false,
    ws: `ws://${local.host}:${local.wsPort}`,
    reason: '',
  }
  return {
    needed: true,
    hosting: info.hosting,
    url: info.url,
    ws: info.ws,
    running: info.running === true,
    step: info.url === ''
      ? '先点上面的「启动」把插件 UI 服务拉起来，拿到地址后再填进 Penpot'
      : 'Penpot → 插件 → 从 URL 载入 → 填上面的地址 → 加载后点 Connect MCP Server',
    note: info.reason === '' ? '插件自己的静态服务，停服务时一起停' : info.reason,
  }
}

export { DEFAULTS, DEFAULT_PORTS, resolveConfig }
