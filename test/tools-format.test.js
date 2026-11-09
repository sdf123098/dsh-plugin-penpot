import test from 'node:test'
import assert from 'node:assert/strict'
import { formatReadResult } from '../src/tools.js'

test('formatReadResult("page")：板块里的图层也要列出来（不然「我写的圆呢」）', () => {
  // 注意：REST 读回来的字段是 camelCase（frameId / fillColor），
  // 写进去的是 kebab-case。这段曾经因此永远匹配不到嵌套图层。
  const data = {
    name: 'Page 1',
    objects: {
      '0000-root': { id: '0000-root', name: 'Root Frame', type: 'frame' },
      'board-1': { id: 'board-1', name: '画板', type: 'frame', width: 400, height: 400 },
      'circle-1': {
        id: 'circle-1',
        name: '绿圆',
        type: 'circle',
        width: 100,
        height: 100,
        x: 150,
        y: 150,
        frameId: 'board-1',
        fills: [{ fillColor: '#16a34a' }],
      },
    },
  }
  const text = formatReadResult('page', data)
  assert.match(text, /板块内的图层/)
  assert.match(text, /绿圆/)
  assert.match(text, /100×100/)
  assert.match(text, /#16a34a/)
})

test('formatReadResult("page")：没有嵌套图层时不输出空段落', () => {
  const data = {
    name: 'Page 1',
    objects: { 'b': { id: 'b', name: '空板', type: 'frame', width: 10, height: 10 } },
  }
  assert.equal(formatReadResult('page', data).includes('板块内的图层'), false)
})
