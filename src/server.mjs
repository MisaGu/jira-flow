// The service's own server: its page (web/), the API — every call of contract/calls.schema.json is one route and one
// engine method — and the event stream (GET api/events, event jira — what the sync did). It listens on 127.0.0.1 only
// and answers only to its own Host (127.0.0.1 or localhost with its port: a foreign page that rebinds its name to this
// machine gets nothing); a POST needs the header x-flow: 1 (a foreign page cannot send it without CORS, which the
// server never allows); a body is checked against its definition before the engine sees it.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFlow } from './engine.mjs'
import { FlowError } from './errors.mjs'
import { schema, validateRef } from './schema.mjs'

export const PORT = 47392
const WEB = fileURLToPath(new URL('../web/', import.meta.url))
const HEARTBEAT_MS = 25000
const MAX_BODY = 8 * 1024 * 1024
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png' }

// route → (flow, input, host) → result; input — the body of a POST, the query of a GET. The table of the contract
// ($defs.routes of calls.schema.json) names the same routes: a test keeps them equal.
export const ROUTES = {
  'GET /api/flow': (flow) => flow.overview(),
  'GET /api/flow/labels': (flow) => flow.labels(),
  'POST /api/flow/login': (flow, b) => flow.login(b),
  'POST /api/flow/logout': (flow) => flow.logout(),
  'GET /api/flow/check': (flow, q) => flow.check({ project: q.get('project') }),
  'POST /api/flow/apply': (flow, b) => flow.apply(b),
  'POST /api/flow/create': (flow, b) => flow.create(b),
  'GET /api/flow/roles': (flow, q) => flow.roles({ project: q.get('project') }),
  'POST /api/flow/roles': (flow, b) => flow.saveRoles(b),
  'GET /api/space': (flow) => flow.state(),
  'POST /api/space/link': (flow, b) => flow.setLink(b),
  'GET /api/space/epic': (flow) => flow.epic(),
  'GET /api/space/epics': (flow) => flow.epics(),
  'POST /api/space/epic': (flow, b) => flow.setEpic(b),
  'GET /api/space/sync': (flow) => flow.sync(),
  'POST /api/space/sync': (flow, b) => flow.setSync(b),
  'POST /api/space/add': (flow, b) => flow.add(b),
  'GET /api/space/feed': (flow) => flow.feed(),
  'POST /api/space/items': (flow, b, host) => {
    if (!host.space?.put) throw new FlowError('INPUT', 'this host takes no items through the API')
    const ids = host.space.put(b.items)
    flow.changed(ids)
    return { count: ids.length, ids }
  },
}

// host — src/hosts.mjs or the caller's own; lang — the language of texts for a person; the rest goes to createFlow
// (client, ops, fetch — for tests).
export async function serve({ port = PORT, host, lang = 'en', ...opts } = {}) {
  if (!host) throw new FlowError('INPUT', 'serve needs a host (src/hosts.mjs)')
  const clients = new Set()
  function emit(event, data) {
    const chunk = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of clients) if (!res.writableEnded) res.write(chunk)
  }
  const flow = createFlow({ host, emit, lang, ...opts })
  const table = schema('calls').$defs.routes
  let actual = port

  const send = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
    res.end(JSON.stringify(obj))
  }
  async function body(req) {
    const chunks = []
    let size = 0
    for await (const c of req) {
      size += c.length
      if (size > MAX_BODY) throw new FlowError('INPUT', 'the request is too large')
      chunks.push(c)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      throw new FlowError('INPUT', 'the request body is not JSON')
    }
  }
  const ownHost = (h) => h === `127.0.0.1:${actual}` || h === `localhost:${actual}`

  const server = http.createServer(async (req, res) => {
    if (!ownHost(req.headers.host)) return send(res, 421, { ok: false, error: 'wrong Host', code: 'INPUT' })
    const url = new URL(req.url, `http://${req.headers.host}`)
    const route = `${req.method} ${url.pathname}`
    if (route === 'GET /api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' })
      res.write(': ok\n\n')
      clients.add(res)
      const hb = setInterval(() => res.write(': \n\n'), HEARTBEAT_MS)
      req.on('close', () => {
        clearInterval(hb)
        clients.delete(res)
      })
      return
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && req.headers['x-flow'] !== '1') return send(res, 403, { ok: false, error: 'no header x-flow', code: 'INPUT' })
      const fn = ROUTES[route]
      if (!fn) return send(res, 404, { ok: false, error: 'no such route', code: 'NOT_FOUND' })
      try {
        let input = url.searchParams
        if (req.method === 'POST') {
          input = await body(req)
          const def = table[route]?.body
          const problems = def ? validateRef(input, 'calls', def) : []
          if (problems.length) throw new FlowError('INPUT', `the body does not fit ${def}: ${problems.slice(0, 5).join('; ')}`)
        }
        return send(res, 200, { ok: true, result: await fn(flow, input, host) })
      } catch (e) {
        return send(res, 400, { ok: false, error: flow.said(e), code: e.code || null })
      }
    }
    const rel = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)
    const file = path.resolve(WEB, `.${rel}`)
    if (!file.startsWith(WEB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(302, { location: '/' })
      return res.end()
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  actual = server.address().port
  async function close() {
    flow.close()
    for (const c of clients) c.end()
    await new Promise((r) => server.close(r))
  }
  return { server, port: actual, url: `http://127.0.0.1:${actual}/`, flow, close }
}
