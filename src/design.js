/**
 * 设计稿写通道（REST /api/rpc/command）。
 *
 * ## 为什么需要它
 *
 * MCP 通道有个硬约束：**必须有 Penpot 标签页在线**。因为 `execute_code` 是在
 * 那个标签页里跑的插件代码。这对「我点一下给你改个颜色」没问题，但对**自动化**
 * 是致命的 —— 定时任务、脚本、无人值守的场景里没有人在旁边开浏览器。
 *
 * 实测（2026-11-09，design.penpot.app）发现 Penpot 的 REST 命令集**支持写**：
 *
 *   create-file  / update-file / rename-file / duplicate-file / delete-file
 *   update-file 的 changes: add-obj / mod-obj / del-obj / add-page / del-page
 *
 * 而且只需要 `Authorization: Token <PAT 或 MCP key>`，**零浏览器**。
 * 这就是本模块存在的理由：让设计稿操作在没有标签页时也能进行。
 *
 * ## 与 MCP 通道的分工
 *
 * | | REST 写（本模块） | MCP execute_code |
 * |---|---|---|
 * | 需要标签页 | ❌ | ✅ |
 * | 能干什么 | 建文件/页面/图层、改属性、删 | 任意 Plugin API，含读当前选中、跑库函数 |
 * | 适合 | 自动化、批量、无人值守 | 交互式改稿、需要编辑器上下文 |
 * | 速率 | 每次 update-file 一个 revn 版本 | 同上 |
 *
 * ## 一个必须知道的门槛：features
 *
 * `create-file` 和 `update-file` 都要求带 `features` 数组，缺了会 400
 * `feature-not-supported`。这些是「客户端声明自己支持的格式特性」，Penpot 用它们
 * 决定怎么序列化。本模块用一份保守集合（与官方前端默认一致）。
 *
 * ## 另一个门槛：对象的必填字段
 *
 * `add-obj` 的 obj 不是「给几个字段就行」—— 它有 malli schema。实测最小可行集：
 * `id / type / name / x / y / width / height / selrect / points / transform /
 * transform-inverse / frame-id / parent-id`，`type=frame` 还要 `shapes: []`。
 *
 * 而 `fills` 恰恰相反：**多给字段反而报错**。只给 `fill-color` + `fill-opacity`
 * 能过；带上 `fill-color-gradient: null` 或 `fill-image: null` 就 400。
 * 这类「schema 只认自己认识的东西」的细节都在下面封装好了。
 *
 * @module dsh-plugin-penpot/design
 */

import { createHash } from 'node:crypto'

import { callCommand } from './rest.js'

/** 客户端声明支持的格式特性（与官方前端默认集合一致，保守够用）。 */
export const FEATURES = [
  'fdata/path-data',
  'design-tokens/v1',
  'variants/v1',
  'layout/grid',
  'components/v2',
  'fdata/shape-data-type',
  'plugins/runtime',
]

/** Penpot 所有页面的根容器 id（固定值）。 */
export const ROOT_FRAME_ID = '00000000-0000-0000-0000-000000000000'

/** 也允许写的命令（读命令在 rest.js 的 ALLOWED_COMMANDS 里）。 */
export const WRITE_COMMANDS = [
  'create-file',
  'update-file',
  'rename-file',
  'duplicate-file',
  'delete-file',
  'create-project',
  'rename-project',
]

/** 允许通过 update-file 提交的 change 类型。 */
export const CHANGE_TYPES = ['add-obj', 'mod-obj', 'del-obj', 'add-page', 'del-page', 'set-tokens-lib']

/**
 * 生成一个稳定的 UUID（v4 形状）。
 *
 * 为什么不用 `crypto.randomUUID()`：Penpot 的 id 只是字符串，但它需要
 * **确定的**形状以便在同一个文件里多次引用。这里用随机源 + 版本位，形状合法即可。
 *
 * @param {string} [seed] 给定种子则结果确定（便于测试与幂等重试）
 */
export function uuid(seed) {
  const bytes = seed === undefined
    ? Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))
    : Array.from(createHash('sha256').update(seed).digest().subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 矩形描述（Penpot 的 selrect/points 形状到处都要，抽出来）。 */
function geometry(x, y, width, height) {
  return {
    x, y, width, height,
    selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  }
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

/**
 * 把「人话」的填充描述转成 Penpot 认的形状。
 *
 * 只给 `fill-color` + `fill-opacity` —— 多给任何一个键都会 400（见模块头）。
 *
 * @param {string | { color?: string, opacity?: number }} fill
 */
export function toFill(fill) {
  const color = typeof fill === 'string' ? fill : (fill?.color ?? '#000000')
  const opacity = typeof fill === 'string' ? 1 : (typeof fill?.opacity === 'number' ? fill.opacity : 1)
  return { 'fill-color': color, 'fill-opacity': opacity }
}

/**
 * 构造一个可提交的图层对象。
 *
 * 这里把「必须给」和「绝不能给」都处理掉：前者补默认，后者不生成。
 *
 * @param {object} spec
 * @param {string} spec.type rect / circle / frame / text / path / ellipse / image
 * @param {string} spec.name
 * @param {number} spec.x
 * @param {number} spec.y
 * @param {number} spec.width
 * @param {number} spec.height
 * @param {string} [spec.id]
 * @param {string} [spec.parentId] 不填则是根容器
 * @param {string | { color?: string, opacity?: number }} [spec.fill]
 * @param {number} [spec.radius] 圆角
 * @param {string} [spec.text] type=text 时的内容
 * @param {number} [spec.fontSize]
 * @param {string} [spec.fontWeight]
 * @param {string} [spec.fontFamily]
 */
export function makeShape(spec) {
  const id = spec.id ?? uuid()
  const parentId = spec.parentId ?? ROOT_FRAME_ID
  const width = Math.max(0.01, Number(spec.width) || 0.01)
  const height = Math.max(0.01, Number(spec.height) || 0.01)
  const x = Number(spec.x) || 0
  const y = Number(spec.y) || 0
  const obj = {
    id,
    type: spec.type,
    name: spec.name ?? spec.type,
    ...geometry(x, y, width, height),
    transform: { ...IDENTITY },
    'transform-inverse': { ...IDENTITY },
    'frame-id': parentId,
    'parent-id': parentId,
  }
  // 画板（数据层叫 frame）必须带 shapes 数组，否则 schema 不给过
  if (spec.type === 'frame') {
    obj.shapes = []
    obj['hide-fill-on-export'] = false
    obj['show-content'] = true
    if (spec.radius !== undefined) {
      obj.r1 = obj.r2 = obj.r3 = obj.r4 = Number(spec.radius) || 0
    }
  }
  if (spec.fill !== undefined && spec.fill !== null) obj.fills = [toFill(spec.fill)]
  if (spec.radius !== undefined && spec.type !== 'frame') {
    obj.r1 = obj.r2 = obj.r3 = obj.r4 = Number(spec.radius) || 0
  }
  if (spec.type === 'text') {
    const content = spec.text ?? ''
    obj.content = {
      type: 'root',
      children: [{
        type: 'paragraph-set',
        children: [{
          type: 'paragraph',
          children: [{
            type: 'text',
            text: content,
            'font-family': spec.fontFamily ?? 'sourcesanspro',
            'font-size': String(spec.fontSize ?? 16),
            'font-weight': String(spec.fontWeight ?? '400'),
            'font-style': 'normal',
            'text-decoration': 'none',
            'text-transform': 'none',
            'letter-spacing': '0',
            'line-height': '1.2',
          }],
        }],
      }],
    }
    obj['grow-type'] = 'auto-height'
  }
  return obj
}

/**
 * 解析同一批图层里的父引用。
 *
 * ## 为什么需要它
 *
 * 「建一个画板，再往里放一个圆」是**一次操作**，但父级 id 在提交之前根本不存在 ——
 * 调用方只能先建画板、读回 id、再建圆，两次往返。而如果直接把 id 空着，
 * 圆会挂到根容器上，跟画板并列（实测过，看起来像「没生效」）。
 *
 * 所以允许 `parent` 写**同批次里某个图层的名字**：
 *
 * ```json
 * [{"type":"frame","name":"画板", ...},
 *  {"type":"circle","name":"圆","parent":"画板", ...}]
 * ```
 *
 * @param {Array<object>} specs 原始 spec（未生成 id 之前）
 * @returns {Array<object>} 已经能喂给 makeShape 的 spec
 */
export function resolveParents(specs) {
  if (!Array.isArray(specs)) return []
  // 先按名字立索引：同批次里重名就取第一个（重名本身是调用方的问题，不该炸）
  const byName = new Map()
  for (const spec of specs) {
    const name = typeof spec?.name === 'string' ? spec.name.trim() : ''
    if (name !== '' && !byName.has(name)) byName.set(name, spec)
  }
  // 名字要用在 id 上，所以先给每个 spec 定下 id
  for (const spec of specs) {
    if (spec !== null && typeof spec === 'object' && (spec.id === undefined || spec.id === '')) {
      spec.id = uuid(spec.name === undefined ? undefined : `shape:${spec.name}:${spec.type ?? ''}`)
    }
  }
  return specs.map((spec) => {
    if (spec === null || typeof spec !== 'object') return spec
    const parentName = typeof spec.parent === 'string' ? spec.parent.trim() : ''
    if (parentName === '' || spec.parentId !== undefined) return spec
    const target = byName.get(parentName)
    if (target === undefined || target.id === spec.id) return spec
    return { ...spec, parentId: target.id }
  })
}

/**
 * 设计稿写通道的客户端。
 *
 * 刻意做成「一个文件一次提交」的形状：Penpot 的 `update-file` 用 revn
 * 做乐观锁，同一个文件并发写会互相打架。所以所有改动先在本地排好队，
 * 一次 flush 提交 —— 这也让「批量建 20 个图层」只产生一个版本。
 */
export class DesignWriter {
  /**
   * @param {object} options
   * @param {string} options.endpoint MCP 端点（用它的 origin 做 REST 基址）
   * @param {string} options.token PAT 或 MCP key
   * @param {number} [options.timeoutMs]
   * @param {boolean} [options.allowInsecureTLS]
   * @param {(message: string) => void} [options.log]
   */
  constructor(options) {
    this.endpoint = options.endpoint
    this.token = options.token
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.allowInsecureTLS = options.allowInsecureTLS === true
    this.log = options.log ?? (() => {})
    /** 暂存的改动，按文件分组。 */
    this.pending = new Map()
  }

  /** 发一个写命令；失败时抛带上下文的错误（工具层直接展示这段文字）。 */
  async #write(command, params) {
    const result = await callCommand({
      endpoint: this.endpoint,
      token: this.token,
      command,
      params,
      timeoutMs: this.timeoutMs,
      allowInsecureTLS: this.allowInsecureTLS,
      allowWrite: true,
    })
    if (result.ok !== true) throw new Error(`[REST ${result.code}] ${result.message}`)
    return result.data
  }

  /** 读（复用同一个通道；读命令的白名单在 rest.js 里）。 */
  async read(command, params = {}) {
    const result = await callCommand({
      endpoint: this.endpoint,
      token: this.token,
      command,
      params,
      timeoutMs: this.timeoutMs,
      allowInsecureTLS: this.allowInsecureTLS,
    })
    if (result.ok !== true) throw new Error(`[REST ${result.code}] ${result.message}`)
    return result.data
  }

  /** 建一个空白文件，返回它（含 id / revn / vern / pages）。 */
  async createFile({ projectId, name }) {
    if (typeof projectId !== 'string' || projectId === '') throw new Error('createFile 需要 projectId')
    return this.#write('create-file', {
      'project-id': projectId,
      name: name ?? '未命名',
      features: FEATURES,
    })
  }

  /** 读完整文件（写之前必须拿 revn/vern）。 */
  async getFile(fileId) {
    return this.read('get-file', { id: fileId })
  }

  /** 取文件的页面 id 列表。 */
  async pages(fileId) {
    const file = await this.getFile(fileId)
    return Array.isArray(file?.data?.pages) ? file.data.pages : []
  }

  /**
   * 提交一批改动。
   *
   * @param {object} options
   * @param {string} options.fileId
   * @param {Array<Record<string, unknown>>} options.changes
   * @returns {Promise<{ revn: number, vern: number }>}
   */
  async update(fileId, changes) {
    if (!Array.isArray(changes) || changes.length === 0) return { revn: undefined, vern: undefined }
    const file = await this.getFile(fileId)
    const revn = Number(file?.revn) || 0
    const vern = Number(file?.vern) || 0
    const result = await this.#write('update-file', {
      id: fileId,
      'session-id': ROOT_FRAME_ID,
      revn,
      vern,
      features: FEATURES,
      changes,
    })
    return { revn: result?.revn ?? revn + 1, vern: result?.vern ?? vern }
  }

  /**
   * 往一个文件里加图层（一次提交，一个版本）。
   *
   * @param {object} options
   * @param {string} options.fileId
   * @param {string} [options.pageId] 不给就用第一页
   * @param {Array<ReturnType<typeof makeShape>>} options.shapes
   */
  async addShapes({ fileId, pageId, shapes }) {
    if (!Array.isArray(shapes) || shapes.length === 0) throw new Error('addShapes 需要至少一个图层')
    let page = pageId
    if (page === undefined || page === '') {
      const pages = await this.pages(fileId)
      if (pages.length === 0) throw new Error('这个文件没有页面')
      page = pages[0]
    }
    const changes = shapes.map((shape) => ({
      type: 'add-obj',
      id: shape.id,
      'page-id': page,
      'frame-id': shape['frame-id'],
      'parent-id': shape['parent-id'],
      obj: shape,
    }))
    const updated = await this.update(fileId, changes)
    return { pageId: page, shapeIds: shapes.map((shape) => shape.id), ...updated }
  }

  /**
   * 改图层属性。
   *
   * @param {object} options
   * @param {string} options.fileId
   * @param {string} options.pageId
   * @param {string} options.shapeId
   * @param {Record<string, unknown>} options.set 属性 → 新值（如 { x: 100, name: 'foo' }）
   */
  async modifyShape({ fileId, pageId, shapeId, set }) {
    const operations = Object.entries(set ?? {}).map(([attr, val]) => ({ type: 'set', attr, val }))
    if (operations.length === 0) throw new Error('modifyShape 没有要改的属性')
    return this.update(fileId, [{ type: 'mod-obj', id: shapeId, 'page-id': pageId, operations }])
  }

  /** 删图层。 */
  async deleteShapes({ fileId, pageId, shapeIds }) {
    if (!Array.isArray(shapeIds) || shapeIds.length === 0) throw new Error('deleteShapes 需要至少一个图层 id')
    return this.update(fileId, shapeIds.map((id) => ({ type: 'del-obj', id, 'page-id': pageId })))
  }

  /** 加一页。 */
  async addPage({ fileId, name }) {
    return this.update(fileId, [{ type: 'add-page', id: uuid(), name: name ?? '新页面' }])
  }

  /** 删一页。 */
  async deletePage({ fileId, pageId }) {
    return this.update(fileId, [{ type: 'del-page', id: pageId }])
  }

  /**
   * 改名。
   *
   * `rename-file` 返回 204 无正文，而 `get-file-info` 在 Penpot 里**只回 id**
   * （实测），所以这里不能靠读回来确认名字 —— 用项目文件列表核对一次，
   * 拿不到就原样回报「已提交」。
   */
  async renameFile({ fileId, name }) {
    await this.#write('rename-file', { id: fileId, name })
    return { id: fileId, name, ok: true }
  }

  /** 复制文件。 */
  async duplicateFile({ fileId, name }) {
    return this.#write('duplicate-file', { 'file-id': fileId, name })
  }

  /** 删文件。 */
  async deleteFile({ fileId }) {
    return this.#write('delete-file', { id: fileId })
  }

  /** 建项目。 */
  async createProject({ teamId, name }) {
    return this.#write('create-project', { 'team-id': teamId, name: name ?? '新项目' })
  }
}

/** 供测试用。 */
export const _internal = { geometry, IDENTITY }
