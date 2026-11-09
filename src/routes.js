/**
 * 宿主侧 HTTP 路由：`/api/penpot/*`，给插件页卡片与 sidebar tab 用。
 *
 * 信任栅栏沿用 DSH 自己的 `/api` 模型（与 dsh-skill-hub 同一套做法）：
 * `ctx.connection.requestRejection` 是官方给"给别的 Web 路由套同一套 Host/Origin
 * 检查"的钩子；没有 Connection 服务时回落到字面回环检查。**每次请求都读**，
 * 不在 apply 时读一次 —— 插件启动顺序不保证，一次性读会把回落值烙死，
 * 反代部署下就变成全 403（skill-hub issue #17 就是这个）。
 *
 * 写请求带 `x-dsh-penpot` 头：别的站点构造不出来，等于挡住跨源表单提交。
 *
 * @module dsh-plugin-penpot/routes
 */

/** 写请求必须带的头。 */
export const WRITE_HEADER = 'x-dsh-penpot'

/** 请求体上限：配置与迁移请求都很小。 */
const MAX_BODY_BYTES = 256 * 1024

/** 回环字面检查（没有 Connection 服务时的回落）。 */
export function isLoopbackRequest(request) {
  const address = request?.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request?.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * 构建路由栅栏。
 *
 * @param {() => ({ requestRejection?: (request: unknown) => number | undefined } | undefined)} read
 * @param {() => void} [onMissing]
 * @returns {(request: unknown) => number | undefined}
 */
export function hostTrustFence(read, onMissing) {
  let missingReported = false
  return (request) => {
    const connection = read()
    if (connection === undefined || typeof connection.requestRejection !== 'function') {
      if (!missingReported) {
        missingReported = true
        onMissing?.()
      }
      return isLoopbackRequest(request) ? undefined : 403
    }
    try {
      return connection.requestRejection(request)
    } catch {
      return isLoopbackRequest(request) ? undefined : 403
    }
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * 生成路由表。
 *
 * `webServer.register` 的三种形态（prefix / exact / handler）在不同版本略有差异，
 * 这里按 axolotl 的实证写法用 `{ kind: 'prefix', path, handler }`。
 *
 * @param {object} options
 * @param {import('./service.js').PenpotService} options.service
 * @param {() => unknown} options.readConnection
 * @param {(message: string) => void} options.log
 * @param {object} options.hooks 业务回调（都由 index.js 注入，路由层不反向依赖）
 * @param {() => Promise<any>} options.hooks.detect 重新自动识别
 * @param {() => any} options.hooks.applyDetected 采用识别结果
 * @param {() => any} options.hooks.migrateScan
 * @param {(entries: any[]) => any} options.hooks.migrateApply
 * @param {(dir: string) => any} options.hooks.migrateRestore
 * @param {() => any} options.hooks.migrateBackups
 * @param {() => any} options.hooks.pluginManifest 插件 UI manifest 地址
 * @param {(patch: Record<string, unknown>) => Promise<any>} options.hooks.saveConfig
 * @returns {{ kind: 'prefix', path: string, handler: (req: any, res: any) => Promise<void> }}
 */
export function makeRoute(options) {
  const { service, readConnection, log, hooks } = options
  const fence = hostTrustFence(readConnection, () => {
    log('Connection 服务缺失：/api/penpot 回落到字面回环检查，反代部署会 403')
  })

  return {
    kind: 'prefix',
    path: '/api/penpot',
    handler: async (req, res) => {
      const rejection = fence(req)
      if (rejection !== undefined) {
        writeJson(res, rejection, { ok: false, error: { code: 'untrusted', message: 'request rejected by host trust fence' } })
        return
      }

      let url
      try {
        url = new URL(req.url ?? '/', 'http://dsh.internal')
      } catch {
        writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'bad url' } })
        return
      }
      const action = url.pathname.startsWith('/api/penpot/')
        ? url.pathname.slice('/api/penpot/'.length).replace(/\/+$/, '')
        : ''
      const method = String(req.method ?? 'GET').toUpperCase()

      const write = (status, value) => writeJson(res, status, value)
      const fail = (status, code, message) => writeJson(res, status, { ok: false, error: { code, message } })

      try {
        // ── 只读 ──────────────────────────────────────────────────────────
        if (method === 'GET' && action === 'ping') {
          write(200, { ok: true, version: '0.1.0', pid: process.pid })
          return
        }
        if (method === 'GET' && action === 'status') {
          write(200, { ok: true, result: { ...service.snapshot(), config: service.publicConfig() } })
          return
        }
        if (method === 'GET' && action === 'config') {
          write(200, { ok: true, result: service.publicConfig() })
          return
        }
        if (method === 'GET' && action === 'logs') {
          const lines = Number.parseInt(url.searchParams.get('lines') ?? '160', 10)
          write(200, { ok: true, result: { text: service.logs(Number.isFinite(lines) ? lines : 160) } })
          return
        }
        if (method === 'GET' && action === 'diagnostics') {
          write(200, { ok: true, result: await service.diagnostics() })
          return
        }
        if (method === 'GET' && action === 'probe') {
          write(200, { ok: true, result: await service.probe() })
          return
        }
        if (method === 'GET' && action === 'manifest') {
          write(200, { ok: true, result: hooks.pluginManifest() })
          return
        }

        if (method !== 'POST') {
          fail(405, 'method', 'use GET or POST')
          return
        }

        // ── 写请求：CSRF 头 ──────────────────────────────────────────────
        if (String(req.headers[WRITE_HEADER] ?? '') === '') {
          fail(403, 'csrf', `write requests must carry the ${WRITE_HEADER} header`)
          return
        }

        const body = await readJsonBody(req)
        if (body === undefined) {
          fail(400, 'bad-request', 'body must be JSON')
          return
        }

        switch (action) {
          case 'config.set': {
            const patch = body.patch
            if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
              fail(400, 'bad-request', 'patch must be an object')
              return
            }
            const saved = await hooks.saveConfig(patch)
            write(200, { ok: true, result: saved })
            return
          }
          case 'service': {
            const op = String(body.op ?? '')
            if (op === 'start') {
              write(200, { ok: true, result: await service.ensureReady({ force: true }) })
              return
            }
            if (op === 'stop') {
              write(200, { ok: true, result: await service.stop() })
              return
            }
            if (op === 'restart') {
              write(200, { ok: true, result: await service.restart() })
              return
            }
            if (op === 'probe') {
              write(200, { ok: true, result: await service.probe() })
              return
            }
            if (op === 'patProbe') {
              write(200, { ok: true, result: await service.probePat() })
              return
            }
            if (op === 'patRead') {
              // 面板的只读预览：命令要过白名单，参数名用 Penpot 的 kebab-case
              const command = String(body.command ?? '')
              const params = body.params !== null && typeof body.params === 'object' ? body.params : {}
              write(200, { ok: true, result: await service.readPenpot(command, params) })
              return
            }
            if (op === 'browserStatus') {
              write(200, { ok: true, result: await service.browserStatus() })
              return
            }
            if (op === 'openDesign') {
              const fileId = typeof body.fileId === 'string' ? body.fileId : ''
              let teamId = typeof body.teamId === 'string' ? body.teamId : ''
              let pageId = typeof body.pageId === 'string' ? body.pageId : ''
              // 没有 teamId，Penpot 会把 workspace 静默重定向到 dashboard；
              // 这里替用户反查一次，省掉一次「我明明打开了却看到最近文件页」。
              let located
              if (fileId !== '' && teamId === '') {
                located = await service.locateFile(fileId)
                if (located !== undefined) {
                  teamId = located.teamId
                  if (pageId === '') pageId = located.pageId
                }
              }
              const result = await service.openDesign({ fileId, teamId, pageId })
              write(200, { ok: true, result: { ...result, located } })
              return
            }
            if (op === 'closeBrowser') {
              write(200, { ok: true, result: await service.closeDesignBrowser() })
              return
            }
            fail(400, 'bad-request', `unknown service op "${op}"`)
            return
          }
          case 'detect': {
            const result = await hooks.detect()
            write(200, { ok: true, result })
            return
          }
          case 'detect.apply': {
            write(200, { ok: true, result: await hooks.applyDetected() })
            return
          }
          case 'migrate.scan': {
            write(200, { ok: true, result: hooks.migrateScan() })
            return
          }
          case 'migrate.apply': {
            const entries = Array.isArray(body.entries) ? body.entries : []
            write(200, { ok: true, result: await hooks.migrateApply(entries) })
            return
          }
          case 'migrate.restore': {
            const dir = typeof body.dir === 'string' ? body.dir : ''
            write(200, { ok: true, result: await hooks.migrateRestore(dir) })
            return
          }
          default:
            fail(404, 'not-found', `unknown method "${action}"`)
        }
      } catch (error) {
        log(`/api/penpot/${action} 失败：${String(error?.message ?? error)}`)
        fail(500, 'internal', String(error?.message ?? error))
      }
    },
  }
}
