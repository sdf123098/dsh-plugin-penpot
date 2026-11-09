/**
 * 设计稿写通道的测试。
 *
 * 这里全部用**本地起的 HTTP 服务器**打桩，不打桩函数、不联网 ——
 * 这样验到的是真实报文形状（认证头、features 数组、change 结构），
 * 而且能断言「发了什么」而不只是「返回了什么」。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  CHANGE_TYPES,
  DesignWriter,
  FEATURES,
  ROOT_FRAME_ID,
  WRITE_COMMANDS,
  makeShape,
  resolveParents,
  toFill,
  uuid,
} from '../src/design.js'
import { callCommand, WRITE_ALLOWED } from '../src/rest.js'

/** 起一个假 Penpot REST 服务，记录请求。 */
async function withPenpot(handler, fn) {
  const requests = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let parsed
      try { parsed = body === '' ? {} : JSON.parse(body) } catch { parsed = body }
      const record = { method: req.method, url: req.url, headers: req.headers, body: parsed }
      requests.push(record)
      handler(req, res, record, requests)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn({ base, requests })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const json = (res, value, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(value))
}

test('uuid 形状合法，且给定种子时结果确定', () => {
  const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  assert.match(uuid(), v4)
  assert.match(uuid('seed'), v4)
  assert.equal(uuid('seed'), uuid('seed'), '同种子必须同结果（幂等重试要靠它）')
  assert.notEqual(uuid('a'), uuid('b'))
})

test('toFill 只给 fill-color 与 fill-opacity', () => {
  // 实测：多给 fill-image / fill-color-gradient 会让 Penpot 400
  const fill = toFill('#2563eb')
  assert.deepEqual(Object.keys(fill).sort(), ['fill-color', 'fill-opacity'])
  assert.deepEqual(toFill({ color: '#fff', opacity: 0.5 }), { 'fill-color': '#fff', 'fill-opacity': 0.5 })
  assert.deepEqual(toFill(), { 'fill-color': '#000000', 'fill-opacity': 1 })
})

test('makeShape 补齐 schema 必填字段', () => {
  const shape = makeShape({ type: 'rect', name: 'Box', x: 10, y: 20, width: 100, height: 50 })
  for (const key of ['id', 'type', 'name', 'x', 'y', 'width', 'height', 'selrect', 'points', 'transform', 'transform-inverse', 'frame-id', 'parent-id']) {
    assert.ok(key in shape, `缺 ${key} —— Penpot 的 malli schema 会 400`)
  }
  assert.equal(shape['frame-id'], ROOT_FRAME_ID)
  assert.equal(shape.selrect.x2, 110)
  assert.equal(shape.points.length, 4)
})

test('makeShape：frame 必须带 shapes 数组，text 必须有 content', () => {
  const frame = makeShape({ type: 'frame', name: 'B', x: 0, y: 0, width: 10, height: 10 })
  assert.deepEqual(frame.shapes, [], 'type=frame 没有 shapes 会 400')
  const text = makeShape({ type: 'text', name: 'T', x: 0, y: 0, width: 10, height: 10, text: 'hi' })
  assert.equal(text.content.type, 'root')
  assert.equal(text.content.children[0].children[0].children[0].text, 'hi')
  assert.equal(text['grow-type'], 'auto-height')
})

test('makeShape：圆角写进 r1..r4', () => {
  const shape = makeShape({ type: 'rect', name: 'R', x: 0, y: 0, width: 10, height: 10, radius: 12 })
  assert.deepEqual([shape.r1, shape.r2, shape.r3, shape.r4], [12, 12, 12, 12])
})

test('makeShape：不传 fill 就不生成 fills 键', () => {
  const shape = makeShape({ type: 'rect', name: 'R', x: 0, y: 0, width: 10, height: 10 })
  assert.equal('fills' in shape, false)
})

test('callCommand 拒绝不在白名单的命令', async () => {
  await withPenpot((_req, res) => res.end('{}'), async ({ base }) => {
    const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'k', command: 'delete-team' })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'not-allowed')
  })
})

test('写命令必须显式 allowWrite —— 防止只读路径误改稿子', async () => {
  await withPenpot((_req, res) => res.end('{}'), async ({ base, requests }) => {
    const blocked = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'k', command: 'delete-file', params: { id: 'x' } })
    assert.equal(blocked.ok, false)
    assert.equal(blocked.code, 'write-requires-opt-in')
    assert.equal(requests.length, 0, '被拒的写请求不该真的发出去')

    const allowed = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'k', command: 'delete-file', params: { id: 'x' }, allowWrite: true })
    assert.equal(allowed.ok, true)
    assert.equal(requests.length, 1)
  })
})

test('204 是成功（rename-file 之类无正文），不能当失败', async () => {
  await withPenpot((_req, res) => { res.writeHead(204); res.end() }, async ({ base }) => {
    const result = await callCommand({ endpoint: `${base}/mcp/stream`, token: 'k', command: 'rename-file', params: { id: 'x', name: 'n' }, allowWrite: true })
    assert.equal(result.ok, true, '204 被当成失败会变成「改成功了却报错」')
    assert.equal(result.status, 204)
  })
})

test('createFile 带 features（缺了会 400 feature-not-supported）', async () => {
  await withPenpot((_req, res, request) => {
    json(res, { id: 'f1', name: request.body.name, revn: 0, vern: 0 })
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    const file = await writer.createFile({ projectId: 'p1', name: 'My File' })
    assert.equal(file.id, 'f1')
    const request = requests[0]
    assert.equal(request.url, '/api/rpc/command/create-file')
    assert.equal(request.headers.authorization, 'Token k')
    assert.deepEqual(request.body.features, FEATURES)
    assert.equal(request.body['project-id'], 'p1')
  })
})

test('addShapes 一次 update-file 提交全部图层（只产生一个版本）', async () => {
  await withPenpot((_req, res, request) => {
    if (request.url.endsWith('/get-file')) {
      json(res, { id: 'f1', revn: 7, vern: 3, data: { pages: ['p1'] } })
      return
    }
    if (request.url.endsWith('/update-file')) {
      json(res, { revn: 8, vern: 3 })
      return
    }
    json(res, {})
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    const board = makeShape({ id: 'b1', type: 'frame', name: 'Board', x: 0, y: 0, width: 100, height: 100 })
    const box = makeShape({ id: 'r1', type: 'rect', name: 'Box', x: 0, y: 0, width: 10, height: 10, parentId: 'b1' })
    const result = await writer.addShapes({ fileId: 'f1', shapes: [board, box] })

    const update = requests.find((r) => r.url.endsWith('/update-file'))
    assert.ok(update, '应该发过 update-file')
    assert.equal(update.body.changes.length, 2, '两个图层要一次提交')
    assert.equal(update.body.revn, 7, 'revn 要用刚才读到的值（乐观锁）')
    assert.equal(update.body.vern, 3)
    assert.deepEqual(update.body.features, FEATURES)
    assert.equal(update.body.changes[0].type, 'add-obj')
    assert.equal(update.body.changes[0]['page-id'], 'p1')
    assert.equal(update.body.changes[1].obj['parent-id'], 'b1')
    assert.equal(result.revn, 8)
  })
})

test('modifyShape 把属性翻成 set 操作', async () => {
  await withPenpot((_req, res, request) => {
    if (request.url.endsWith('/get-file')) return json(res, { revn: 1, vern: 1, data: { pages: ['p1'] } })
    json(res, { revn: 2, vern: 1 })
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    await writer.modifyShape({ fileId: 'f1', pageId: 'p1', shapeId: 's1', set: { x: 500, name: 'moved' } })
    const update = requests.find((r) => r.url.endsWith('/update-file'))
    assert.equal(update.body.changes[0].type, 'mod-obj')
    assert.equal(update.body.changes[0].id, 's1')
    assert.deepEqual(update.body.changes[0].operations, [
      { type: 'set', attr: 'x', val: 500 },
      { type: 'set', attr: 'name', val: 'moved' },
    ])
  })
})

test('deleteShapes 每个 id 一条 del-obj', async () => {
  await withPenpot((_req, res, request) => {
    if (request.url.endsWith('/get-file')) return json(res, { revn: 1, vern: 1, data: { pages: ['p1'] } })
    json(res, { revn: 2, vern: 1 })
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    await writer.deleteShapes({ fileId: 'f1', pageId: 'p1', shapeIds: ['a', 'b'] })
    const update = requests.find((r) => r.url.endsWith('/update-file'))
    assert.equal(update.body.changes.length, 2)
    assert.ok(update.body.changes.every((change) => change.type === 'del-obj'))
  })
})

test('addPage / deletePage 用 CHANGE_TYPES 里的类型', async () => {
  await withPenpot((_req, res, request) => {
    if (request.url.endsWith('/get-file')) return json(res, { revn: 1, vern: 1, data: { pages: ['p1'] } })
    json(res, { revn: 2, vern: 1 })
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    await writer.addPage({ fileId: 'f1', name: 'Screens' })
    await writer.deletePage({ fileId: 'f1', pageId: 'p2' })
    const updates = requests.filter((r) => r.url.endsWith('/update-file'))
    assert.equal(updates[0].body.changes[0].type, 'add-page')
    assert.equal(updates[0].body.changes[0].name, 'Screens')
    assert.equal(updates[1].body.changes[0].type, 'del-page')
    assert.ok(CHANGE_TYPES.includes(updates[0].body.changes[0].type))
  })
})

test('写失败时抛出带 code 的错误（工具层直接展示）', async () => {
  await withPenpot((_req, res) => {
    json(res, { type: 'validation', code: 'params-validation', explain: 'bad' }, 400)
  }, async ({ base }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    await assert.rejects(() => writer.createFile({ projectId: 'p', name: 'n' }), /http|validation/)
  })
})

test('没有 token 时给出可动手的提示', async () => {
  await withPenpot((_req, res) => res.end('{}'), async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: '' })
    await assert.rejects(() => writer.createFile({ projectId: 'p', name: 'n' }), /PAT|MCP key/)
    assert.equal(requests.length, 0)
  })
})

test('白名单本身：写命令都在 WRITE_ALLOWED 里，且不含危险操作', () => {
  for (const command of WRITE_COMMANDS) {
    assert.ok(WRITE_ALLOWED.includes(command), `${command} 应该被允许`)
  }
  for (const dangerous of ['delete-team', 'update-team', 'delete-profile', 'update-profile', 'delete-project']) {
    assert.equal(WRITE_ALLOWED.includes(dangerous), false, `${dangerous} 不该开`)
  }
})

test('getFile：先读再写，revn 用读到的值', async () => {
  await withPenpot((_req, res, request) => {
    if (request.url.endsWith('/get-file')) return json(res, { id: 'f1', revn: 42, vern: 9, data: { pages: ['p1'] } })
    json(res, { revn: 43, vern: 9 })
  }, async ({ base, requests }) => {
    const writer = new DesignWriter({ endpoint: `${base}/mcp/stream`, token: 'k' })
    await writer.update('f1', [{ type: 'del-page', id: 'p9' }])
    const update = requests.find((r) => r.url.endsWith('/update-file'))
    assert.equal(update.body.revn, 42)
    assert.equal(update.body.vern, 9)
  })
})

test('resolveParents：parent 写名字能解析成同批次图层的 id', () => {
  const specs = [
    { type: 'frame', name: '画板', x: 0, y: 0, width: 400, height: 400 },
    { type: 'circle', name: '圆', x: 150, y: 150, width: 100, height: 100, parent: '画板' },
  ]
  const resolved = resolveParents(specs)
  assert.equal(resolved[1].parentId, resolved[0].id, '圆的 parentId 必须指向画板')
  assert.notEqual(resolved[0].id, resolved[1].id, '两个图层不能撞 id')
})

test('resolveParents：给的 parentId 优先，不被 parent 名字覆盖', () => {
  const specs = [
    { type: 'frame', name: 'A' },
    { type: 'frame', name: 'B' },
    { type: 'circle', name: 'C', parent: 'A', parentId: 'explicit-id' },
  ]
  const resolved = resolveParents(specs)
  assert.equal(resolved[2].parentId, 'explicit-id')
})

test('resolveParents：parent 指向不存在的名字时原样返回（交给根容器）', () => {
  const resolved = resolveParents([{ type: 'circle', name: '孤圆', parent: '不存在的画板' }])
  assert.equal(resolved[0].parentId, undefined)
})

test('resolveParents：自己指向自己不会造成自环', () => {
  const resolved = resolveParents([{ type: 'frame', name: '自己', parent: '自己' }])
  assert.equal(resolved[0].parentId, undefined, '不能把自己挂到自己身上')
})

test('resolveParents：非法输入不炸', () => {
  assert.deepEqual(resolveParents(undefined), [])
  assert.deepEqual(resolveParents('nope'), [])
  assert.doesNotThrow(() => resolveParents([null, undefined, 1]))
})

test('resolveParents 之后 makeShape 得到的 parent-id 与 frame-id 一致', () => {
  const specs = [
    { type: 'frame', name: '板', x: 0, y: 0, width: 100, height: 100 },
    { type: 'rect', name: '块', x: 0, y: 0, width: 10, height: 10, parent: '板' },
  ]
  const shapes = resolveParents(specs).map(makeShape)
  assert.equal(shapes[1]['parent-id'], shapes[0].id)
  assert.equal(shapes[1]['frame-id'], shapes[0].id)
})
