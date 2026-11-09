/**
 * 客户端半边的装载测试。
 *
 * `lib/client.js` 是经典脚本：宿主在浏览器里注入它，它调
 * `window.__ModuleLoader__.load({ id, factory })`，factory 只拿到
 * `react` 和 `react/jsx-runtime` 两个 require 种子。
 *
 * 这里用假的 window + 极简 react 替身把同一份文件跑一遍，能抓到
 * 「客户端半边一装载就抛」这类宿主里最难查的问题（浏览器里只看到白屏）。
 * 不测渲染结果，只测装载契约：注册了哪个槽、传了什么 key、组件是不是函数。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/** 极简 React 替身：element 只记录类型与 props，不渲染。 */
function reactStub() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: Symbol('Fragment'),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn,
    useRef: (initial) => ({ current: initial }),
    createContext: (value) => ({ Provider: null, Consumer: null, _value: value }),
    useContext: (context) => context?._value,
  }
}

/**
 * 把 client.js 在一个隔离的 vm 环境里装载起来。
 * @returns {{ exports: any, registry: { id?: string } }}
 */
function loadClient() {
  const react = reactStub()
  const jsxRuntime = {
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
    Fragment: react.Fragment,
  }
  const registry = {}
  // 只有 <style> 注入用得到 DOM；给足 dataset / textContent / appendChild 就行
  const makeElement = () => ({ dataset: {}, textContent: '', setAttribute: () => {}, appendChild: () => {} })
  const fakeDocument = {
    head: { appendChild: () => {} },
    createElement: makeElement,
    getElementById: () => undefined,
    querySelector: () => undefined,
  }
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          registry.id = id
          registry.exports = factory((name) => {
            if (name === 'react') return react
            if (name === 'react/jsx-runtime') return jsxRuntime
            throw new Error(`unexpected require: ${name}`)
          })
        },
      },
      document: fakeDocument,
    },
    document: fakeDocument,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: {} }) }),
    module: { exports: {} },
    exports: {},
    require: () => ({}),
    Symbol,
    Object,
    Array,
    JSON,
    Math,
    Date,
    Promise,
    Error,
    Number,
    String,
    Boolean,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  return { exports: registry.exports, registry, sandbox }
}

test('client.js 用 __ModuleLoader__ 装载，id 与包名一致', () => {
  const { registry } = loadClient()
  assert.equal(registry.id, 'dsh-plugin-penpot')
})

test('装载后导出 apply，且注入清单是数组', () => {
  const { exports } = loadClient()
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject))
})

test('apply 注册插件页卡片，key 是本包名', () => {
  const { exports } = loadClient()
  const registered = []
  const scoped = {
    slots: {
      register: (descriptor, component) => {
        registered.push({ descriptor, component })
        return () => {}
      },
      inject: (name, callback) => callback(),
    },
  }
  // 宿主用 ctx.inject(['slots'], cb) 做服务就绪回调
  const ctx = {
    inject: (services, callback) => {
      if (services.includes('slots')) return callback(scoped)
      return undefined
    },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  exports.apply(ctx)

  const card = registered.find((entry) => entry.descriptor.name === 'plugins.bundle.config')
  assert.ok(card, '应该往 plugins.bundle.config 注册过')
  assert.equal(card.descriptor.key, 'dsh-plugin-penpot', 'key 必须是包名，插件页才挂得上')
  assert.equal(typeof card.component, 'function')
  assert.equal(typeof card.descriptor.inject, 'function')
})

test('apply 在装了 better-sidebar 时注册侧栏页', () => {
  const { exports } = loadClient()
  const tabs = []
  const scoped = {
    slots: { register: () => () => {}, inject: () => {} },
    betterSidebar: {
      registerTab: (descriptor) => {
        tabs.push(descriptor)
        return () => {}
      },
    },
  }
  const ctx = {
    inject: (services, callback) => {
      if (services.includes('betterSidebar')) return callback(scoped)
      if (services.includes('slots')) return callback(scoped)
      return undefined
    },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  exports.apply(ctx)

  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].id, 'penpot:dashboard')
  assert.equal(typeof tabs[0].component, 'function')
  assert.ok(Number.isFinite(tabs[0].order))
})

test('没装 better-sidebar 时不报错（可选服务不能拖垮整棵客户端树）', () => {
  const { exports } = loadClient()
  const scoped = {
    slots: { register: () => () => {}, inject: () => {} },
  }
  const ctx = {
    inject: (services, callback) => {
      if (services.includes('betterSidebar')) return undefined // 服务不在
      if (services.includes('slots')) return callback(scoped)
      return undefined
    },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  assert.doesNotThrow(() => exports.apply(ctx))
})

test('裸 ctx（没有 inject / effect）也不抛', () => {
  const { exports } = loadClient()
  assert.doesNotThrow(() => exports.apply({}))
})

test('面板块的文案中英都有，且不写死颜色（只用 CSS 变量）', () => {
  const { exports } = loadClient()
  const registered = []
  const scoped = {
    slots: {
      register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {} },
      inject: (name, callback) => callback(),
    },
  }
  const ctx = {
    inject: (services, callback) => (services.includes('slots') ? callback(scoped) : undefined),
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  exports.apply(ctx)
  const card = registered.find((entry) => entry.descriptor.name === 'plugins.bundle.config')
  const injected = card.descriptor.inject()
  assert.ok(injected.t, '卡片要拿到文案表')
  // 至少要有中英两套
  const keys = Object.keys(injected.t)
  assert.ok(keys.length >= 2)
})

test('PAT 与浏览器区块的中英文案两套都齐（缺一套会让界面某半边显示 undefined）', () => {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  // TEXTS 里 zh / en 两块各有一份文案；这里直接数出现次数，
  // 比装载后取一份更直接 —— `inject()` 只回当前语言那一份。
  const keys = [
    'patHint:', 'patReuse:', 'patSource:', 'patVerify:', 'patReuseHint:',
    'browserHint:', 'browserAuto:', 'browserPath:', 'browserHeadless:', 'browserOpen:', 'browserClose:', 'browserNotAvailable:',
  ]
  for (const key of keys) {
    const count = source.split(key).length - 1
    assert.ok(count >= 2, `${key} 应该在中英两套文案里各出现一次，实际 ${count} 次`)
  }
})

test('面板不会把脱敏后的端点值填进可编辑输入框（真事故的防线）', () => {
  const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  // 一旦有人把 cleanEndpoint 去掉、直接写 config.official?.endpoint，
  // 用户点「保存」就会用 userToken=*** 覆盖真凭据。
  assert.match(source, /officialEndpoint:\s*cleanEndpoint\(/, '官方端点必须过 cleanEndpoint')
  assert.match(source, /selfhostUrl:\s*cleanEndpoint\(/, '自部署地址必须过 cleanEndpoint')
  assert.equal(/officialEndpoint:\s*config\./.test(source), false, '不能把原始（含 userToken）端点直接塞进表单')
  assert.equal(/selfhostUrl:\s*config\.selfhost\?\.url/.test(source), false, '不能把原始自部署地址直接塞进表单')
})

test('卡片能真的渲染一遍而不抛（空状态 + 有状态两种）', () => {
  const { exports } = loadClient()
  const registered = []
  const scoped = {
    slots: {
      register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {} },
      inject: (name, callback) => callback(),
    },
  }
  const ctx = {
    inject: (services, callback) => (services.includes('slots') ? callback(scoped) : undefined),
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  exports.apply(ctx)
  const card = registered.find((entry) => entry.descriptor.name === 'plugins.bundle.config')

  // 空状态：config / status 都还没读到
  assert.doesNotThrow(() => card.component({ t: ctx.__t }), '空状态渲染不该抛')
  // 有文案表 + 完整 status（含 channels）
  const fakeT = card.descriptor.inject().t
  const status = {
    state: 'rest',
    mode: 'official',
    endpoint: 'https://design.penpot.app/mcp/stream',
    toolCount: 0,
    tools: [],
    lastProbe: { stage: 'no-instance', detail: '' },
    channels: {
      mcp: { usable: false, stage: 'no-instance', label: 'Penpot 未连上来', needsTab: true },
      rest: { usable: true, stage: 'ok', label: '凭据有效', needsTab: false, configured: true },
    },
  }
  assert.doesNotThrow(() => card.component({ t: fakeT, ctx: {}, status }), '有状态渲染不该抛')
})

test('侧栏页也能渲染而不抛', () => {
  const { exports } = loadClient()
  const tabs = []
  const scoped = {
    slots: { register: () => () => {}, inject: () => {} },
    betterSidebar: { registerTab: (descriptor) => { tabs.push(descriptor); return () => {} } },
  }
  const ctx = {
    inject: (services, callback) => {
      if (services.includes('betterSidebar')) return callback(scoped)
      if (services.includes('slots')) return callback(scoped)
      return undefined
    },
    effect: (fn) => { try { return fn() } catch { return undefined } },
    get: () => undefined,
  }
  exports.apply(ctx)
  assert.doesNotThrow(() => tabs[0].component({ ctx: {}, visible: true }))
})

test('渲染里用到的每个 t.xxx 在中英两套里都有定义（防止某半边显示 undefined）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  // 只看渲染/逻辑部分，避免把文案表自己算进去
  const body = src.slice(src.indexOf('const CSS = `'))
  const used = new Set()
  for (const m of body.matchAll(/\bt\.([a-zA-Z_][a-zA-Z0-9_]*)/g)) used.add(m[1])

  const zhBlock = src.slice(src.indexOf('zh: {'), src.indexOf('en: {'))
  const enBlock = src.slice(src.indexOf('en: {'), src.indexOf('function pickTexts'))
  const defined = block => new Set([...block.matchAll(/^\s+([a-zA-Z_][a-zA-Z0-9_]*): '/gm)].map(m => m[1]))

  // 这几个是按状态拼出来的（t[`state_${status.state}`]），不是字面量
  const dynamic = new Set(['state_idle', 'state_starting', 'state_running', 'state_rest', 'state_waiting', 'state_degraded', 'state_stopping'])
  const zh = defined(zhBlock)
  const en = defined(enBlock)

  const missingZh = [...used].filter(k => !zh.has(k) && !dynamic.has(k))
  const missingEn = [...used].filter(k => !en.has(k) && !dynamic.has(k))
  assert.deepEqual(missingZh, [], `中文缺：${missingZh.join(', ')}`)
  assert.deepEqual(missingEn, [], `英文缺：${missingEn.join(', ')}`)
})

test('没有定义了却没人用的死文案键', () => {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const body = src.slice(src.indexOf('const CSS = `'))
  const used = new Set([...body.matchAll(/\bt\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map(m => m[1]))
  const zhBlock = src.slice(src.indexOf('zh: {'), src.indexOf('en: {'))
  const declared = [...zhBlock.matchAll(/^\s+([a-zA-Z_][a-zA-Z0-9_]*): '/gm)].map(m => m[1])
  // state_* 是动态拼的；title/sidebarTitle 由宿主读
  const exempt = new Set(['title', 'sidebarTitle', 'state_idle', 'state_starting', 'state_running', 'state_rest', 'state_waiting', 'state_degraded', 'state_stopping'])
  const dead = declared.filter(k => !used.has(k) && !exempt.has(k))
  assert.deepEqual(dead, [], `这些键没人用，删掉：${dead.join(', ')}`)
})

test('面板文案里不出现 Markdown 记号（会原样显示成星号）', () => {
  const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
  const zhBlock = src.slice(src.indexOf('zh: {'), src.indexOf('function pickTexts'))
  const offenders = [...zhBlock.matchAll(/^\s+([a-zA-Z_][a-zA-Z0-9_]*): '([^']*\*\*[^']*)'/gm)]
    .map(m => `${m[1]}: ${m[2].slice(0, 60)}`)
  assert.deepEqual(offenders, [], `这些文案里的 ** 会原样显示：\n${offenders.join('\n')}`)
})
