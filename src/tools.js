/**
 * 模型侧工具：5 个上游工具 + status + control。
 *
 * 设计取舍：**不把上游工具表摊平**（Penpot 现在 4–5 个，将来可能变），
 * 而是按「面向上游同名」注册 —— 好处是模型看到的工具名和 Penpot 官方文档
 * 完全一致，@ 文档里的例子能直接用；坏处是上游加工具时要跟着改一张表，
 * 所以表在这里集中，改一处即可。
 *
 * 每个工具在 execute 里先 ensureReady()：本地档会顺手拉起进程，
 * 失败时返回结构化错误（缺 dist / 缺 corepack / 端口被占 / 远端不可达），
 * 不让模型猜「为什么没反应」。
 *
 * @module dsh-plugin-penpot/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { makeShape, resolveParents } from './design.js'

/** 写操作的输出 schema。 */
const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    text: { type: 'string', required: true, description: '给模型看的可读文本' },
  },
}

/** 把上游结果包成统一的 { text } 形状。 */
function asText(value) {
  return { text: value }
}

/**
 * `penpot_read` 的 what → REST 命令映射。
 *
 * `required` 是必填参数在工具入参里的名字，`optional` 是可选参数；
 * `params` 负责把模型侧的 camelCase 翻成 Penpot RPC 要的 kebab-case
 * （这层转换就放在这一张表里，别散到各处）。
 */
const READ_PLAN = {
  teams: { command: 'get-teams' },
  team: { command: 'get-team', required: 'teamId', params: { teamId: 'id' } },
  projects: { command: 'get-projects', required: 'teamId', params: { teamId: 'team-id' } },
  projectFiles: { command: 'get-project-files', required: 'projectId', params: { projectId: 'project-id' } },
  recentFiles: { command: 'get-team-recent-files', required: 'teamId', params: { teamId: 'team-id' } },
  fileInfo: { command: 'get-file-info', required: 'fileId', params: { fileId: 'id' } },
  fileSummary: { command: 'get-file-summary', required: 'fileId', params: { fileId: 'id' } },
  fileLibraries: { command: 'get-file-libraries', required: 'fileId', params: { fileId: 'file-id' } },
  // 页面列表：只有 get-file 带 data.pages，返回给调用方的只是 id 列表，不留整包
  pages: { command: 'get-file', required: 'fileId', params: { fileId: 'id' }, compact: 'pages' },
  // get-page 必须两个参数都给：只给 file-id 会拿回默认页（Page 1，通常只有一个 Root Frame）
  page: { command: 'get-page', required: 'fileId', optional: 'pageId', params: { fileId: 'file-id', pageId: 'page-id' } },
  teamMembers: { command: 'get-team-members', required: 'teamId', params: { teamId: 'team-id' } },
}

/**
 * 把 REST 结果压成一小段可读文本。
 *
 * 为什么不直接 JSON.stringify：`get-page` / `get-file-summary` 的原文能有几十 KB，
 * 全塞进上下文既费 token 又难读。这里只挑「够看懂结构」的字段，其余说一句怎么再取。
 *
 * @param {string} what
 * @param {unknown} data
 */
export function formatReadResult(what, data) {
  const list = (items, mapper) => (Array.isArray(items) ? items.map(mapper).join('\n') : '（空）')
  switch (what) {
    case 'teams':
      return `团队（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (team) => `  ${team?.id}  ${team?.name ?? '未命名'}`)
    case 'team':
      return `团队：${data?.name ?? '未命名'}  id=${data?.id}`
    case 'projects':
      return `项目（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (project) => `  ${project?.id}  ${project?.name ?? '未命名'}  ${project?.count ?? project?.totalCount ?? '?'} 个文件`)
    case 'projectFiles':
      return `文件（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (file) => `  ${file?.id}  ${file?.name ?? '未命名'}  revn=${file?.revn ?? '?'}  ${file?.modifiedAt ?? ''}`)
    case 'recentFiles':
      return `最近文件（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (file) => `  ${file?.id}  ${file?.name ?? '未命名'}  ${file?.modifiedAt ?? ''}`)
    case 'teamMembers':
      return `成员（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (member) => `  ${member?.id ?? member?.profileId}  ${member?.name ?? member?.email ?? ''}`)
    case 'fileInfo':
      return `文件：${data?.name ?? '未命名'}  revn=${data?.revn ?? '?'}  ${data?.modifiedAt ?? ''}`
    case 'fileLibraries':
      return `连接的库（${Array.isArray(data) ? data.length : 0}）：\n` + list(data, (library) => `  ${library?.id}  ${library?.name ?? '未命名'}`)
    case 'fileSummary': {
      const parts = []
      for (const [key, value] of Object.entries(data ?? {})) {
        if (value !== null && typeof value === 'object' && 'count' in value) parts.push(`  ${key}: ${value.count}`)
      }
      return parts.length === 0 ? JSON.stringify(data).slice(0, 800) : `文件摘要：\n${parts.join('\n')}`
    }
    case 'page': {
      const objects = data?.objects ?? {}
      const total = Object.keys(objects).length
      // 注意：文件格式里板块的类型是 `frame`，不是编辑器里叫的 board
      const boards = Object.values(objects).filter((shape) => shape?.type === 'frame' && shape?.name !== 'Root Frame')
      const texts = Object.values(objects).filter((shape) => shape?.type === 'text')
      const groups = Object.values(objects).filter((shape) => shape?.type === 'group')
      const lines = [
        `页面：${data?.name ?? '未命名'}  共 ${total} 个对象（板块 ${boards.length} / 组 ${groups.length} / 文本 ${texts.length}）`,
      ]
      if (boards.length > 0) {
        lines.push('板块：')
        for (const board of boards.slice(0, 30)) {
          const size = board?.width === undefined || board?.height === undefined
            ? ''
            : `  ${Math.round(board.width)}×${Math.round(board.height)}`
          // Penpot 里板块名常自带尺寸（"Shell / 1280×800"），重复显示没意义
          const duplicated = size !== '' && String(board?.name ?? '').includes(size.trim())
          lines.push(`  ${board?.id}  ${board?.name ?? '未命名'}${duplicated ? '' : size}`)
        }
        if (boards.length > 30) lines.push(`  …还有 ${boards.length - 30} 个板块；要全量走 MCP 通道的 execute_code`)
      }
      // 板块**里面**的图层才是真正要看的东西。之前这里只列板块，
      // 于是「我明明写了圆，怎么读不到」是个高频误会 —— 圆在板块里，不在顶层。
      //
      // 注意：**REST 读回来的字段是 camelCase**（`frameId` / `fillColor`），
      // 跟我们写进去的 kebab-case（`frame-id` / `fill-color`）不一样。写的时候
      // Penpot 收 kebab，读回来一律转成 camel —— 两种都要认，否则这段永远匹配不到。
      const boardIds = new Set(boards.map((board) => board?.id))
      const parentOf = (shape) => (shape === null || shape === undefined) ? undefined : (shape.frameId ?? shape['frame-id'])
      const nested = Object.values(objects).filter((shape) => shape !== null && boardIds.has(parentOf(shape)))
      if (nested.length > 0) {
        lines.push('板块内的图层：')
        for (const shape of nested.slice(0, 60)) {
          const size = shape?.width === undefined || shape?.height === undefined
            ? ''
            : `  ${Math.round(shape.width)}×${Math.round(shape.height)}`
          const at = shape?.x === undefined ? '' : `  @${Math.round(shape.x)},${Math.round(shape.y)}`
          const fill = shape?.fills?.[0]?.fillColor ?? shape?.fills?.[0]?.['fill-color']
          lines.push(`  ${shape?.id}  ${shape?.name ?? '未命名'}  [${shape?.type ?? '?'}]${size}${at}${fill === undefined ? '' : `  ${fill}`}`)
        }
        if (nested.length > 60) lines.push(`  …还有 ${nested.length - 60} 个图层`)
      }
      return lines.join('\n')
    }
    default:
      return JSON.stringify(data).slice(0, 2000)
  }
}

/**
 * 注册全部模型侧工具。
 *
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx
 * @param {import('./service.js').PenpotService} options.service
 * @returns {string[]} 已注册的工具名
 */
export function registerTools(options) {
  const { ctx, service } = options
  const registered = []

  const register = (definition) => {
    ctx.tools.register(definition)
    registered.push(definition.name)
  }

  // ── penpot_status ─────────────────────────────────────────────────────────
  register(defineTool({
    name: 'penpot_status',
    description:
      'Penpot 连接状态速览：两条通道（MCP / REST）各自的状态、档位、工具数。'
      + ' Penpot 工具没反应或报错时先调这个，它给的是诊断信息而不是业务结果。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          state: { type: 'string', required: true },
          mode: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const snapshot = service.snapshot()
      const probe = await service.probe()
      const pat = service.publicConfig().pat
      const lines = [
        `mode: ${snapshot.mode}（用户档位 ${snapshot.mode === service.config.mode ? '同上' : service.config.mode}）`,
        `state: ${snapshot.state}${snapshot.adopted ? '（接管已有实例）' : ''}`,
      ]
      // 两条通道分开报 —— 用一个状态概括两件事必然误导：
      // 「Penpot 标签页没开」只影响 MCP，REST 照样能读写设计稿。
      lines.push(`MCP 通道: ${probe.label} —— ${probe.detail}`)
      const availability = service.patAvailability()
      if (availability.usable) {
        const source = pat.from === 'pat' ? '面板里配的 PAT' : '借用的 MCP key'
        const patProbe = await service.probePat()
        lines.push(`REST 通道: ${patProbe.label}（令牌来自${source}）—— ${patProbe.detail}`)
        if (patProbe.stage === 'ok') {
          lines.push('  → 不需要标签页：penpot_read 读结构，penpot_write 建文件/加图层/改属性都能用。')
        }
      } else if (snapshot.mode !== 'local') {
        lines.push('REST 通道: 没配令牌（面板「连接」里贴 PAT，或打开「借用 MCP key」）')
      }
      lines.push(`endpoint: ${snapshot.endpoint || '(未建连)'}`)
      lines.push(`tools(${snapshot.toolCount}): ${snapshot.tools.join(', ') || '(无)'}`)
      if (snapshot.lastError !== '') lines.push(`last error: ${snapshot.lastError}`)
      if (probe.stage !== 'ok' && snapshot.mode === 'local') {
        // 本地档最常见的卡点就是「插件 UI 没在 Penpot 里加载过」，直接把地址摊开说明
        const host = service.pluginHostInfo()
        if (host.url !== '') {
          lines.push(`插件 UI: ${host.url}`)
          lines.push('  → Penpot → 插件 → 从 URL 载入 → 填上面这个地址 → 加载后点 Connect MCP Server')
        } else if (host.reason !== '') {
          lines.push(`插件 UI 没起来：${host.reason}`)
        }
      }
      return { text: lines.join('\n'), state: snapshot.state, mode: snapshot.mode }
    },
  }))

  // ── 4 个上游读/写工具 ─────────────────────────────────────────────────────
  register(defineTool({
    name: 'penpot_execute_code',
    description:
      '在 Penpot 插件的上下文里执行 JavaScript（上游 execute_code 原样透传）。'
      + ' 可访问 `penpot`（Plugin API）、`penpotUtils`、`storage`。'
      + ' 返回代码里 return 的值。执行前先读 penpot_high_level_overview 能少走弯路。',
    parameters: {
      code: { type: 'string', required: true, description: '要执行的 JavaScript 代码（函数体，可用 return）' },
    },
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const code = String(args.code ?? '')
      if (code.trim() === '') throw new Error('code 不能为空')
      const outcome = await service.callTool('execute_code', { code })
      return asText(outcome.text === '' ? '执行成功，没有返回值。' : outcome.text)
    },
  }))

  register(defineTool({
    name: 'penpot_high_level_overview',
    description:
      '取 Penpot MCP 的「高层概览」：能做什么、用什么 API、常见任务怎么写。'
      + ' 不需要 Penpot 里连上设计稿，任何连接档都能读。',
    parameters: {},
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const outcome = await service.callTool('high_level_overview', {})
      return asText(outcome.text)
    },
  }))

  register(defineTool({
    name: 'penpot_api_info',
    description:
      '查 Penpot Plugin API 的类型/成员信息（上游 penpot_api_info 原样透传）。'
      + ' type 必填（如 "Page"、"Shape"），member 可选（如 "createShape"）。',
    parameters: {
      type: { type: 'string', required: true, description: 'API 类型名' },
      member: { type: 'string', description: '该类型下的成员名，留空返回整个类型' },
    },
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const payload = { type: String(args.type ?? '') }
      if (typeof args.member === 'string' && args.member !== '') payload.member = args.member
      const outcome = await service.callTool('penpot_api_info', payload)
      return asText(outcome.text)
    },
  }))

  register(defineTool({
    name: 'penpot_export_shape',
    description:
      '导出图形。shapeId 可给具体图形 id、"selection"（当前选中）或 "page"（整页）。'
      + ' "page" 会先自动选中这一页的顶层图形再导出（上游直接导整页会因等根容器而超时）。'
      + ' 官方托管/自部署档不能写本地文件，只能拿到图；本地档可传 filePath 落盘。',
    parameters: {
      shapeId: { type: 'string', required: true, description: '图形 id，或 "selection" / "page"' },
      format: { type: 'string', description: 'png（默认）或 svg' },
      mode: { type: 'string', description: 'shape（默认，完整外观）或 fill（填充图，仅 png）' },
      filePath: { type: 'string', description: '可选：保存到本地路径（仅本地档支持）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          text: { type: 'string', required: true },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                attachmentId: { type: 'string', required: true },
                mediaType: { type: 'string', required: true },
                bytes: { type: 'integer', required: true },
                width: { type: 'integer', required: true },
                height: { type: 'integer', required: true },
                name: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const blocks = [{ type: 'text', text: value.text }]
        for (const image of value.images ?? []) blocks.push({ type: 'image', attachment: image })
        return blocks
      },
    },
    async execute(args) {
      const shapeId = String(args.shapeId ?? '').trim()
      const payload = { shapeId }
      if (typeof args.format === 'string' && args.format !== '') payload.format = args.format
      if (typeof args.mode === 'string' && args.mode !== '') payload.mode = args.mode
      if (typeof args.filePath === 'string' && args.filePath !== '') payload.filePath = args.filePath

      // ## shapeId = "page" 在上游是坏的
      //
      // 上游拿到 `page` 会去等 `#screenshot-00000000-0000-0000-0000-000000000000`
      // （根容器）可见，可根容器是个 `0.01×0.01` 的隐藏 SVG，永远等不到 ——
      // 10 秒后 500，报的还是 `locator.waitFor: Timeout`，让人以为是网络问题。
      //
      // 这里改成：先把这一页的顶层图形全选中，再走 `selection`。导出的东西一样，
      // 但走的是上游唯一稳的那条路。
      let effective = shapeId
      if (shapeId === 'page') {
        const picked = await service.callTool('execute_code', {
          code: [
            'const page = penpot.currentPage',
            'const shapes = page.findShapes().filter(s => s.type !== "board" || s.name !== "Root Frame")',
            'penpot.selection = shapes',
            'return shapes.length',
          ].join('\n'),
        }).catch(() => undefined)
        const count = Number((/(\d+)/.exec(String(picked?.text ?? '')) ?? [])[1])
        if (!Number.isFinite(count) || count === 0) {
          return { text: '这一页是空的，没有可导出的图形。' }
        }
        effective = 'selection'
        payload.shapeId = effective
      }

      // shapeId=selection 且当前没有任何选中时，上游会抛一句
      // `Cannot read properties of undefined (reading 'export')` —— 那是内部错误文本，
      // 对使用者毫无意义。先探一次，直接说清楚「没选中东西」。
      if (effective === 'selection' && shapeId !== 'page') {
        const pre = await service.callTool('execute_code', {
          code: 'return (penpot.selection ?? []).length',
        }).catch(() => undefined)
        // execute_code 的返回值在 text 里（不是 result）；有的上游会包一层 JSON
        const raw = String(pre?.text ?? '').trim()
        const count = Number((/(\d+)/.exec(raw) ?? [])[1])
        if (Number.isFinite(count) && count === 0) {
          return {
            text: '当前没有选中任何图形。先在右边画布上点一个图层，或把 shapeId 换成具体 id / "page"（整页）。',
          }
        }
      }

      const outcome = await service.callTool('export_shape', payload)
      const images = await toAttachments(ctx, outcome.images ?? [])
      return { text: outcome.text === '' ? '导出完成。' : outcome.text, ...(images.length === 0 ? {} : { images }) }
    },
  }))

  // import_image 只对本地档存在（remote 模式官方不给这个工具）。
  register(defineTool({
    name: 'penpot_import_image',
    description:
      '把本地图片导入到 Penpot（上游 import_image 原样透传）。**只有本地档有**：'
      + '官方托管/自部署档不允许访问本地文件系统，此时该工具会明确报错。',
    parameters: {
      filePath: { type: 'string', required: true, description: '本地图片路径' },
      pageId: { type: 'string', description: '可选：目标页面 id' },
    },
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      if (!service.tools.includes('import_image')) {
        throw new Error(
          `当前档位（${service.effectiveMode()}）没有 import_image —— remote 模式不允许访问本地文件系统。`
          + ' 需要导入本地图片请切到 local 档（本机跑 MCP 服务器）。',
        )
      }
      const payload = { filePath: String(args.filePath ?? '') }
      if (typeof args.pageId === 'string' && args.pageId !== '') payload.pageId = args.pageId
      const outcome = await service.callTool('import_image', payload)
      return asText(outcome.text === '' ? '导入完成。' : outcome.text)
    },
  }))

  // ── penpot_read（PAT 只读通道） ────────────────────────────────────────────
  register(defineTool({
    name: 'penpot_read',
    description:
      '走 Penpot 的 REST API 只读一条数据（团队 / 项目 / 文件 / 页面结构 / 文件摘要）。'
      + ' 和前面几个工具走**不同通道**：这条用的是个人访问令牌（Authorization: Token），不需要 Penpot 标签页在线 —— '
      + 'Penpot 没点 Connect、或者你想离线确认凭据是否有效时用它。只能读，不能改设计稿。',
    parameters: {
      what: {
        type: 'string',
        required: true,
        description:
          '要读什么：teams（团队列表）| team（单个团队，要 teamId）| projects（项目列表，要 teamId）| '
          + 'projectFiles（项目下的文件，要 projectId）| recentFiles（团队最近文件，要 teamId）| '
          + 'fileInfo（文件基本信息，要 fileId）| pages（文件的页面 id 列表，要 fileId）| '
          + 'fileSummary（组件/颜色/字体统计，要 fileId）| fileLibraries（文件连接的库，要 fileId）| '
          + 'page（某一页的完整结构，要 fileId + pageId）| teamMembers（团队成员，要 teamId）'
          + ' | verifyToken（只验凭据是否有效）',
      },
      teamId: { type: 'string', description: 'what=team/projects/recentFiles/teamMembers 时必填' },
      projectId: { type: 'string', description: 'what=projectFiles 时必填' },
      fileId: { type: 'string', description: 'what=fileInfo/fileSummary/fileLibraries/page 时必填' },
      pageId: { type: 'string', description: 'what=page 时强烈建议给：不给会拿回默认页（通常只有一个 Root Frame）。page 列表见 fileInfo' },
    },
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const what = String(args.what ?? '').trim()
      if (what === 'verifyToken') {
        const result = await service.probePat()
        return asText(`${result.label}：${result.detail}`)
      }
      const plan = READ_PLAN[what]
      if (plan === undefined) {
        return asText(`不认识的 what "${what}"。可用：${Object.keys(READ_PLAN).join(', ')}, verifyToken`)
      }
      const params = {}
      if (plan.required !== undefined) {
        const value = String(args[plan.required] ?? '').trim()
        if (value === '') return asText(`what=${what} 需要 ${plan.required}。`)
        params[plan.params[plan.required]] = value
      }
      if (plan.optional !== undefined) {
        const value = String(args[plan.optional] ?? '').trim()
        if (value !== '') params[plan.params[plan.optional]] = value
      }
      try {
        const data = await service.readPenpot(plan.command, params)
        // get-file 只为拿页面 id 列表，别把 40 MB 的整包塞进上下文
        if (plan.compact === 'pages') {
          const pages = data?.data?.pages ?? data?.pages ?? []
          const index = data?.data?.pagesIndex ?? {}
          const lines = [`页面（${pages.length}）：`]
          for (const id of pages) {
            const objects = index[id]?.objects ?? {}
            // 文件格式里板块是 type=frame（编辑器里叫 board）
            const boards = Object.values(objects).filter((shape) => shape?.type === 'frame' && shape?.name !== 'Root Frame')
            lines.push(`  ${id}  ${boards.length} 个板块  ${Object.keys(objects).length} 个对象`)
          }
          lines.push('用 what=page 加 pageId 读某一页的具体内容。')
          return asText(lines.join('\n'))
        }
        return asText(formatReadResult(what, data))
      } catch (error) {
        return asText(String(error?.message ?? error))
      }
    },
  }))

  // ── penpot_write（REST 写通道，不需要标签页） ─────────────────────────────
  register(defineTool({
    name: 'penpot_write',
    description:
      '不用浏览器就能改设计稿：建文件 / 加页面 / 建图层 / 改属性 / 删图层，全走 Penpot 的 REST API。'
      + ' 和 penpot_execute_code 的区别：**不需要 Penpot 标签页在线**，适合自动化、批量、无人值守。'
      + ' 代价是只能做「文件/图层级」的常规操作，拿不到编辑器上下文（当前选中、插件 API）。'
      + ' 一次调用只产生一个版本（多图层批量提交）。',
    parameters: {
      op: {
        type: 'string',
        required: true,
        description:
          '要做什么：createFile（建文件，要 projectId）| addPage（加页）| addShapes（加图层，见 shapes）| '
          + 'modifyShape（改属性，要 shapeId + set）| deleteShapes（删图层，要 shapeIds）| '
          + 'deletePage（删页，要 pageId）| renameFile（改名）| duplicateFile（复制）| deleteFile（删文件）',
      },
      fileId: { type: 'string', description: '目标文件（createFile 之后才知道，其余 op 必填）' },
      pageId: { type: 'string', description: '页面 id；addShapes 不给就用第一页' },
      projectId: { type: 'string', description: 'createFile 必填：放哪个项目下（penpot_read what=projects 能列）' },
      name: { type: 'string', description: 'createFile / addPage / renameFile / duplicateFile 的名字' },
      shapeId: { type: 'string', description: 'modifyShape 要改的图层 id' },
      shapeIds: { type: 'string', description: 'deleteShapes 要删的图层 id，逗号分隔' },
      set: { type: 'string', description: 'modifyShape 要改的属性，JSON 对象；如 {"x":100,"name":"新名字","fills":[{"fill-color":"#2563eb","fill-opacity":1}]}' },
      shapes: {
        type: 'string',
        description:
          'addShapes 的图层数组（JSON）。每项：{\"type\":\"rect|circle|frame|text\",\"name\":\"...\",\"x\":0,\"y\":0,\"width\":100,\"height\":50,'
          + '"fill":"#2563eb","radius":8,"text":"文字内容","fontSize":16,'
          + '"parent":"同一批里某个图层的名字"}。'
          + ' parentId 直接给父图层的 id；或者用 parent 写同批次里另一个图层的名字 —— '
          + '「建画板 + 往画板里放圆」可以一次提交，不用先建再读回 id。都不给就挂在根容器上。',
      },
    },
    output: {
      schema: TEXT_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const op = String(args.op ?? '').trim()
      let writer
      try {
        writer = service.designWriter()
      } catch (error) {
        return asText(String(error?.message ?? error))
      }
      const fileId = String(args.fileId ?? '').trim()
      const pageId = String(args.pageId ?? '').trim()
      const needFile = () => (fileId === '' ? `op=${op} 需要 fileId。` : undefined)

      try {
        switch (op) {
          case 'createFile': {
            const file = await writer.createFile({
              projectId: String(args.projectId ?? '').trim(),
              name: String(args.name ?? '').trim() || '未命名',
            })
            const pages = Array.isArray(file?.data?.pages) ? file.data.pages : []
            return asText([
              `已建文件：${file.name ?? args.name}  id=${file.id}`,
              `  项目 ${args.projectId}${pages.length > 0 ? `　第一页 ${pages[0]}` : ''}`,
              '用 addShapes 往里加图层（不需要打开浏览器）。',
            ].join('\n'))
          }
          case 'addPage': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            await writer.addPage({ fileId, name: String(args.name ?? '').trim() || '新页面' })
            const pages = await writer.pages(fileId)
            return asText(`已加一页，现在共 ${pages.length} 页：\n${pages.map((id) => `  ${id}`).join('\n')}`)
          }
          case 'addShapes': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            let specs
            try {
              specs = JSON.parse(String(args.shapes ?? '[]'))
            } catch (error) {
              return asText(`shapes 不是合法 JSON：${String(error?.message ?? error)}`)
            }
            if (!Array.isArray(specs) || specs.length === 0) return asText('shapes 要是一个非空数组。')
            // 允许 parent 写同批次里另一个图层的**名字** —— 否则「建画板 + 往画板里放东西」
            // 得先提交一次、读回 id、再提交，两次往返还可能撞 revn
            const shapes = resolveParents(specs).map((spec) => makeShape(spec))
            const result = await writer.addShapes({ fileId, pageId: pageId === '' ? undefined : pageId, shapes })
            return asText([
              `已加 ${shapes.length} 个图层（一次提交，一个版本）：`,
              ...shapes.map((shape) => `  ${shape.id}  ${shape.name ?? shape.type}  [${shape.type}]`),
              `  页面 ${result.pageId}　revn ${result.revn}`,
            ].join('\n'))
          }
          case 'modifyShape': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            const shapeId = String(args.shapeId ?? '').trim()
            if (shapeId === '') return asText('modifyShape 需要 shapeId。')
            if (pageId === '') return asText('modifyShape 需要 pageId（penpot_read what=page 能查）。')
            let set
            try {
              set = JSON.parse(String(args.set ?? '{}'))
            } catch (error) {
              return asText(`set 不是合法 JSON：${String(error?.message ?? error)}`)
            }
            if (set === null || typeof set !== 'object' || Array.isArray(set)) return asText('set 要是一个 JSON 对象。')
            const result = await writer.modifyShape({ fileId, pageId, shapeId, set })
            return asText(`已改 ${Object.keys(set).length} 个属性：${Object.keys(set).join(', ')}　revn ${result.revn}`)
          }
          case 'deleteShapes': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            if (pageId === '') return asText('deleteShapes 需要 pageId。')
            const shapeIds = String(args.shapeIds ?? '').split(',').map((id) => id.trim()).filter((id) => id !== '')
            if (shapeIds.length === 0) return asText('deleteShapes 需要 shapeIds（逗号分隔）。')
            const result = await writer.deleteShapes({ fileId, pageId, shapeIds })
            return asText(`已删 ${shapeIds.length} 个图层　revn ${result.revn}`)
          }
          case 'deletePage': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            if (pageId === '') return asText('deletePage 需要 pageId。')
            await writer.deletePage({ fileId, pageId })
            return asText(`已删页面 ${pageId}`)
          }
          case 'renameFile': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            const name = String(args.name ?? '').trim()
            if (name === '') return asText('renameFile 需要 name。')
            await writer.renameFile({ fileId, name })
            return asText(`已改名为「${name}」`)
          }
          case 'duplicateFile': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            const copy = await writer.duplicateFile({ fileId, name: String(args.name ?? '').trim() || undefined })
            return asText(`已复制：${copy?.name ?? args.name}  id=${copy?.id}`)
          }
          case 'deleteFile': {
            const missing = needFile()
            if (missing !== undefined) return asText(missing)
            await writer.deleteFile({ fileId })
            return asText(`已删文件 ${fileId}`)
          }
          default:
            return asText(`不认识的 op "${op}"。可用：createFile, addPage, addShapes, modifyShape, deleteShapes, deletePage, renameFile, duplicateFile, deleteFile`)
        }
      } catch (error) {
        return asText(String(error?.message ?? error))
      }
    },
  }))

  // ── penpot_control（逃生口） ───────────────────────────────────────────────
  if (service.config.exposeControlTool) {
    register(defineTool({
      name: 'penpot_control',
      description:
        'Penpot 插件的控制面：start / stop / restart / probe / detect / logs / config，'
        + '以及 openDesign / closeBrowser / browserStatus（无人值守地开设计稿）。'
        + ' 服务没起来、档位不对、想重新自动识别本机配置时用它；比让用户去点面板快。',
      parameters: {
        op: {
          type: 'string',
          required: true,
          description: 'start | stop | restart | probe | detect | logs | config | openDesign | closeBrowser | browserStatus',
        },
        lines: { type: 'integer', description: 'op=logs 时返回多少行（默认 80）' },
        fileId: { type: 'string', description: 'op=openDesign 时要打开的设计稿 id（不给就打开 Penpot 首页）' },
        teamId: { type: 'string', description: 'op=openDesign 时的团队 id。不给会自动从 fileId 反查 —— 但反查不到时 Penpot 会重定向到 dashboard' },
        pageId: { type: 'string', description: 'op=openDesign 时要打开的页面 id（可选）' },
      },
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => false,
      async execute(args) {
        // 归一成小写再比：模型可能传 openDesign / opendesign / OpenDesign，
        // 都该认。所以下面的 case 分支一律用小写字面量。
        const op = String(args.op ?? '').trim().toLowerCase()
        switch (op) {
          case 'start': {
            const ready = await service.ensureReady({ force: true })
            return asText(ready.ok
              ? `已启动：${service.snapshot().endpoint}（${ready.tools.length} 个工具）`
              : `启动失败：${ready.error}${ready.hint === undefined ? '' : `\n${ready.hint}`}`)
          }
          case 'stop': {
            const result = await service.stop()
            return asText(result.ok ? `已停止${result.reason === undefined ? '' : `（${result.reason}）`}` : `停止失败：${result.reason}`)
          }
          case 'restart': {
            const ready = await service.restart()
            return asText(ready.ok ? `已重启：${service.snapshot().endpoint}` : `重启失败：${ready.error}`)
          }
          case 'probe': {
            const probe = await service.probe()
            return asText(`${probe.label}\n${probe.detail}\n工具 ${probe.toolCount} 个`)
          }
          case 'logs': {
            const lines = Math.max(10, Math.min(400, Number(args.lines ?? 80)))
            const text = service.logs(lines)
            return asText(text === '' ? '（还没有本地日志 —— 这个档位不跑本地进程，或在 lazy 下还没启动过）' : text)
          }
          case 'config': {
            return asText(JSON.stringify(service.publicConfig(), null, 2))
          }
          case 'detect': {
            // 由 index.js 注入，避免这里反向依赖 detect：见 ctx.penpotDetect
            const detect = ctx.get('penpotDetect')
            if (typeof detect !== 'function') return asText('自动识别还没挂上（插件刚启动？稍后再试）。')
            const result = await detect()
            return asText(result.rationale)
          }
          case 'opendesign': {
            // 无人值守打开设计稿：自己起浏览器，不碰用户的默认浏览器
            const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : ''
            let teamId = typeof args.teamId === 'string' ? args.teamId.trim() : ''
            let pageId = typeof args.pageId === 'string' ? args.pageId.trim() : ''
            // 没有 teamId 的话 Penpot 会静默踢回 dashboard（不报错，只是一张空白的
            // 最近文件页），所以这里主动反查一次，别让用户对着 dashboard 发愣。
            let located
            if (fileId !== '' && teamId === '') {
              located = await service.locateFile(fileId)
              if (located !== undefined) {
                teamId = located.teamId
                if (pageId === '') pageId = located.pageId
              }
            }
            const result = await service.openDesign({ fileId, teamId, pageId })
            if (result.ok !== true) return asText(`打开失败：${result.reason}`)
            return asText([
              `已打开：${result.url}`,
              `  浏览器 ${result.browser}${result.reused === true ? '（复用已有实例）' : ''}　端口 ${result.port}`,
              located === undefined ? '' : `  team-id 自动反查到 ${located.teamId}（项目 ${located.projectId}）`,
              fileId !== '' && teamId === '' ? '⚠ 没查到 team-id —— Penpot 会把 workspace 重定向到 dashboard，请在面板里填 team-id' : '',
              result.profile === undefined ? '' : `  独立 profile：${result.profile}`,
              result.loginHint === undefined ? '' : `⚠ ${result.loginHint}`,
            ].filter((line) => line !== '').join('\n'))
          }
          case 'closebrowser': {
            const result = await service.closeDesignBrowser()
            return asText(result.closed === true ? `已关闭浏览器（pid ${result.pid}）` : `没有需要关的：${result.reason ?? ''}`)
          }
          case 'browserstatus': {
            const status = await service.browserStatus()
            if (status.available !== true) return asText(`不能自动开浏览器：${status.reason}`)
            const lines = [
              `可驱动浏览器：${status.kind}（${status.path}）`,
              `实例状态：${status.running ? `运行中 pid ${status.pid}，端口 ${status.port}` : '没在跑'}`,
            ]
            if (status.url !== '') lines.push(`当前页面：${status.url}`)
            lines.push(`独立 profile：${status.profile}`)
            return asText(lines.join('\n'))
          }
          default:
            return asText(`不认识的 op "${op}"。可用：start, stop, restart, probe, detect, logs, config, openDesign, closeBrowser, browserStatus（大小写都认）`)
        }
      },
    }))
  }

  return registered
}

/**
 * 上游 base64 图片转成 DSH 附件引用（与内建 read_image 的 IMAGE_VALUE schema 对齐）。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Array<{ data: string, mimeType: string }>} images
 */
async function toAttachments(ctx, images) {
  if (!Array.isArray(images) || images.length === 0) return []
  const attachments = ctx.get('attachments')
  if (attachments === undefined) return []
  const refs = []
  for (const [index, image] of images.entries()) {
    try {
      const ref = await attachments.saveImage({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mimeType,
        name: `penpot-${Date.now()}-${index + 1}.${image.mimeType === 'image/jpeg' ? 'jpg' : image.mimeType === 'image/svg+xml' ? 'svg' : 'png'}`,
      })
      refs.push({
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      })
    } catch (error) {
      ctx.logger?.warn?.(`penpot: 图片转附件失败：${String(error?.message ?? error)}`)
    }
  }
  return refs
}
