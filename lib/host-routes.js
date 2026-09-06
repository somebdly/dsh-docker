// Host HTTP 路由：只允许 loopback 访问（看板与 DSH Web GUI 同源同机）。
// GET  /api/mcp-gateway-board/state        -> 看板快照（profiles + servers + gateway + 精简 catalog）
// GET  /api/mcp-gateway-board/catalog?q=   -> 搜索仓库 catalog servers（服务端过滤缓存）
// POST /api/mcp-gateway-board/action       -> { kind, ... } 动作，返回快照/结果
// POST /api/mcp-gateway-board/shell/open   -> { container, shell? } 打开交互终端，返回 { session }
// GET  /api/mcp-gateway-board/shell/stream?session=xxx -> SSE 事件流（pty-out / exit）
// POST /api/mcp-gateway-board/shell/input  -> { session, data } 写入终端输入
// POST /api/mcp-gateway-board/shell/resize -> { session, cols, rows } 调整终端尺寸
// POST /api/mcp-gateway-board/shell/close  -> { session } 关闭终端

const API_PREFIX = '/api/mcp-gateway-board'

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function isLoopback(req) {
  const addr = req.socket && req.socket.remoteAddress
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

function guard(req, res) {
  if (isLoopback(req)) return true
  json(res, 403, { ok: false, error: 'forbidden' })
  return false
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new Error('body-too-large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function makeRoutes(service) {
  const state = {
    kind: 'exact',
    path: `${API_PREFIX}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      json(res, 200, service.getSnapshot())
    },
  }

  const catalog = {
    kind: 'exact',
    path: `${API_PREFIX}/catalog`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const url = new URL(req.url, 'http://localhost')
        const q = (url.searchParams.get('q') || '').trim().toLowerCase()
        const all = Array.isArray(service.snapshot.catalogServers) ? service.snapshot.catalogServers : []
        const list = q === ''
          ? all
          : all.filter((s) => {
              const hay = `${s.name} ${s.title} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase()
              return hay.includes(q)
            })
        json(res, 200, {
          ok: true,
          query: q,
          total: all.length,
          count: list.length,
          servers: list.slice(0, 200),
        })
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    },
  }

  const action = {
    kind: 'exact',
    path: `${API_PREFIX}/action`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      const contentType = req.headers['content-type'] || ''
      if (!contentType.toLowerCase().startsWith('application/json')) {
        return json(res, 415, { ok: false, error: 'json-required' })
      }
      try {
        const body = await readJsonBody(req)
        const result = await service.apply(body)
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message })
      }
    },
  }

  // ---- 交互式容器终端 ----

  const shellOpen = {
    kind: 'exact',
    path: `${API_PREFIX}/shell/open`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const body = await readJsonBody(req)
        const { container, shell } = body || {}
        const result = await service.openShell(String(container || ''), String(shell || 'sh'))
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, error: message })
      }
    },
  }

  const shellStream = {
    kind: 'exact',
    path: `${API_PREFIX}/shell/stream`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      let session = ''
      try {
        const url = new URL(req.url, 'http://localhost')
        session = url.searchParams.get('session') || ''
      } catch {
        /* ignore */
      }
      if (session === '') return json(res, 400, { ok: false, error: 'missing-session' })

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // 立即 flush 一次（建立 SSE 连接）
      res.write(`data: ${JSON.stringify({ type: 'open', session })}\n\n`)

      let closed = false
      const send = (event) => {
        if (closed) return
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`)
        } catch {
          /* ignore */
        }
      }
      let unsubscribe = null
      try {
        unsubscribe = service.subscribeShell(session, send)
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
        return
      }

      const cleanup = () => {
        if (closed) return
        closed = true
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe()
          } catch {
            /* ignore */
          }
        }
        try {
          res.end()
        } catch {
          /* ignore */
        }
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
    },
  }

  const shellInput = {
    kind: 'exact',
    path: `${API_PREFIX}/shell/input`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const body = await readJsonBody(req)
        const { session, data } = body || {}
        await service.writeShell(String(session || ''), String(data ?? ''))
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, error: message })
      }
    },
  }

  const shellResize = {
    kind: 'exact',
    path: `${API_PREFIX}/shell/resize`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const body = await readJsonBody(req)
        const { session, cols, rows } = body || {}
        await service.resizeShell(String(session || ''), Number(cols), Number(rows))
        json(res, 200, { ok: true })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, error: message })
      }
    },
  }

  const shellClose = {
    kind: 'exact',
    path: `${API_PREFIX}/shell/close`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      try {
        const body = await readJsonBody(req)
        const { session } = body || {}
        const result = await service.closeShell(String(session || ''))
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        json(res, 400, { ok: false, error: message })
      }
    },
  }

  return [state, catalog, action, shellOpen, shellStream, shellInput, shellResize, shellClose]
}
