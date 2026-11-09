/**
 * 审批闸门：把「在设计稿里执行代码 / 写本地文件」接到 DSH 的审批流上。
 *
 * 为什么这两件事必须问：Penpot 连着的是用户**正在改的真实设计文件**，
 * execute_code 能删图层、改样式、整页重排；import_image 会把本地文件写进
 * 设计稿。默认在删之前让人看到「这次要动什么」，比事后发现好。
 *
 * 实现方式：`tools/pre-execute` 是 DSH 的工具执行前闸门（waterfall），
 * 返回 `{ kind: 'ask' }` 就走公用审批通道。只在两个条件都满足时 ask：
 *   1. 插件配置 requireApproval 开着
 *   2. 当前会话的审批策略不是 never（用户已经明确关掉审批时再问是骚扰）
 *
 * @module dsh-plugin-penpot/approval
 */

/** 需要审批的工具与它们的说明。 */
const GATED = {
  penpot_execute_code: {
    verb: '在 Penpot 当前打开的设计文件里执行 JavaScript（可能增删改图层、样式、页面）',
    summarize: (args) => {
      const code = typeof args?.code === 'string' ? args.code.trim().replace(/\s+/g, ' ') : ''
      return code === '' ? '' : `代码：${code.length > 160 ? `${code.slice(0, 160)}…` : code}`
    },
  },
  penpot_import_image: {
    verb: '把本地图片写入 Penpot 当前设计稿',
    summarize: (args) => (typeof args?.filePath === 'string' ? `文件：${args.filePath}` : ''),
  },
  penpot_write: {
    // 这条真的会改设计稿（走 REST，不需要浏览器）—— 删图层、建文件都在里面
    verb: '修改 Penpot 设计稿（建/删文件、加/改/删图层、增删页面）',
    summarize: (args) => {
      const op = typeof args?.op === 'string' ? args.op : ''
      const target = typeof args?.fileId === 'string' && args.fileId !== '' ? `文件 ${args.fileId}` : ''
      const name = typeof args?.name === 'string' && args.name !== '' ? `「${args.name}」` : ''
      return [op, name, target].filter((piece) => piece !== '').join(' ')
    },
  },
}

/**
 * 编一句能读的审批理由。
 *
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @returns {string}
 */
export function describeIntent(toolName, args) {
  const spec = GATED[toolName]
  if (spec === undefined) return `执行 ${toolName}`
  const detail = spec.summarize(args)
  return detail === '' ? spec.verb : `${spec.verb}\n${detail}`
}

/**
 * 安装执行前闸门。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ requireApproval: boolean, log?: (message: string) => void }} options
 * @returns {() => void} 卸载函数
 */
export function installApprovalGate(ctx, options) {
  if (!options.requireApproval) {
    options.log?.('审批闸门按配置关闭')
    return () => {}
  }

  const listener = async (exec, next) => {
    // 只拦自己的工具，且只拦这两种真正会动东西的
    const toolName = String(exec?.name ?? '')
    if (Object.prototype.hasOwnProperty.call(GATED, toolName) !== true) return next()

    const args = exec?.arguments ?? {}

    // 审批策略是 never 时再 ask 只会被立刻拒掉（approval.decide 里明确写了这条），
    // 与其让用户莫名其妙看到「被拒绝」，不如放行 —— 这是宿主自己的策略决定。
    const approval = ctx.get('approval')
    if (approval !== undefined && typeof approval.effectivePolicy === 'function' && exec.agent !== undefined) {
      try {
        if (approval.effectivePolicy(exec.agent.session) === 'never') return next()
      } catch {
        // 拿不到策略就按「该问」处理，宁可多问一次
      }
    }

    const reason = describeIntent(toolName, args)
    return { kind: 'ask', reason, displayReason: reason }
  }

  return ctx.on('tools/pre-execute', listener)
}
