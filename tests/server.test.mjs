// The server on a host in a temporary folder and an in-memory Jira: only its own Host, POST only with x-flow, bodies
// checked against the contract, the routes are exactly the contract's table, every result fits it; a client puts items,
// the sync writes them, the event stream tells about it; the page is served, nothing outside web/.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { assert, check, done } from './harness.mjs'
import { fakeJira } from './fixtures/fake-jira.mjs'
import { loadTemplate, localHost, ROUTES, schema, serve, validate, validateRef } from '../index.mjs'

const T = loadTemplate('design-dev')
const jira = fakeJira(T, { parents: [{ key: 'KEY-90', summary: 'Epic' }] })
const readIssue = async (_, key) => {
  const r = await jira.get(`/rest/api/3/issue/${key}?fields=summary`)
  return { id: r.id, key: r.key, summary: r.fields.summary, status: r.fields.status?.name || null, type: r.fields.issuetype?.name, level: r.fields.issuetype?.hierarchyLevel, project: r.fields.project?.key, parent: null }
}
const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jira-flow-serve-'))
const host = localHost({ home })
host.account.save({ site: 'example.atlassian.net', email: 'me@example.com', token: 'tok' })
const s = await serve({ port: 0, host, lang: 'en', client: () => jira, ops: { listProjects: async () => [{ key: 'KEY', name: 'Key' }], isAdmin: async () => false, cloudId: async () => null, readIssue }, settleMs: 5, autostart: false })

// A request without fetch: no proxy of the environment in the way.
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body)
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: res.statusCode, type: res.headers['content-type'], location: res.headers.location, text, json })
      })
    })
    r.on('error', reject)
    if (data) r.write(data)
    r.end()
  })
}
const get = (p) => req('GET', p)
const post = (p, body = {}) => req('POST', p, body, { 'x-flow': '1' })
const table = schema('calls').$defs.routes
const fitsResult = (route, result) => assert.deepEqual(validateRef(result, 'calls', table[route].result), [], route)

await check('contract: the routes are exactly the table of calls.schema.json; every body and result is defined', () => {
  const named = Object.keys(table).filter((k) => k !== 'description')
  assert.deepEqual(Object.keys(ROUTES).sort(), named.sort())
  for (const r of named) {
    for (const def of [table[r].body, table[r].result]) if (def) assert.ok(schema('calls').$defs[def], `${r}: no $defs.${def}`)
    assert.equal(r.startsWith('POST') ? Boolean(table[r].body) : table[r].body === null, true, r)
  }
})

await check('guards: a foreign Host, a POST without x-flow, an unknown route, a body out of the contract', async () => {
  assert.equal((await req('GET', '/api/flow', undefined, { host: `evil.example:${s.port}` })).status, 421)
  assert.equal((await req('POST', '/api/space/link', { project: 'KEY' })).status, 403)
  assert.equal((await get('/api/nope')).status, 404)
  const bad = await post('/api/flow/login', { site: 'example.atlassian.net', email: 'a@b.c' })
  assert.deepEqual([bad.status, bad.json.ok, bad.json.code], [400, false, 'INPUT'])
  assert.match(bad.json.error, /token is required/)
  const extra = await post('/api/space/link', { project: 'KEY', more: 1 })
  assert.match(extra.json.error, /more: not in the schema/)
})

await check('flow and space over HTTP: every result fits the contract; items put by a client go to Jira under the epic', async () => {
  const events = []
  const sse = http.get({ host: '127.0.0.1', port: s.port, path: '/api/events' }, (res) => {
    let buf = ''
    res.on('data', (c) => {
      buf += c
      for (let i; (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const ev = /^event: (.+)$/m.exec(buf.slice(0, i))?.[1]
        const data = /^data: (.+)$/m.exec(buf.slice(0, i))?.[1]
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) })
      }
    })
  })
  const calls = [
    ['GET /api/flow', () => get('/api/flow')],
    ['GET /api/flow/labels', () => get('/api/flow/labels')],
    ['POST /api/space/link', () => post('/api/space/link', { project: 'key' })],
    ['POST /api/space/epic', () => post('/api/space/epic', { epic: 'KEY-90' })],
    ['GET /api/space/epic', () => get('/api/space/epic')],
    ['POST /api/space/sync', () => post('/api/space/sync', { on: true, ids: [] })],
    ['POST /api/space/items', () => post('/api/space/items', { items: [{ id: 'a', summary: 'Item A', status: 'Design Review', notes: [{ id: 'n1', text: 'ready' }], group: 'one' }, { id: 'b', summary: 'Item B', status: 'Design' }] })],
    ['POST /api/space/epic', () => post('/api/space/epic', { epic: 'KEY-90', group: 'one' })],
    ['GET /api/space/epics', () => get('/api/space/epics')],
  ]
  for (const [route, call] of calls) {
    const r = await call()
    assert.equal(r.status, 200, `${route}: ${r.text}`)
    fitsResult(route, r.json.result)
  }
  await s.flow.idle()
  const feed = await get('/api/space/feed')
  fitsResult('GET /api/space/feed', feed.json.result)
  assert.deepEqual([feed.json.result.total, feed.json.result.linked], [2, 2])
  assert.deepEqual([...jira.issues.values()].map((i) => [i.summary, i.status, i.parent]), [['Item A', 'Design Review', 'KEY-90'], ['Item B', 'Design', 'KEY-90']])
  fitsResult('GET /api/space/sync', (await get('/api/space/sync')).json.result)
  fitsResult('GET /api/space', (await get('/api/space')).json.result)
  fitsResult('POST /api/space/add', (await post('/api/space/add', { id: 'a' })).json.result)
  await new Promise((ok) => setTimeout(ok, 50))
  sse.destroy()
  assert.ok(events.length >= 4, `events: ${events.length}`)
  for (const e of events) assert.deepEqual(validate(e, schema('events')), [], JSON.stringify(e))
  assert.ok(!JSON.stringify(fs.readFileSync(path.join(home, 'links.json'), 'utf8')).includes('tok'))
})

await check('the page: index.html at /, files of web/ only, anything else goes back to the page', async () => {
  const page = await get('/')
  assert.equal(page.status, 200)
  assert.match(page.type, /text\/html/)
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/nope.txt', '/%', '/%E0%A4%A']) {
    const r = await get(p)
    assert.ok(r.status === 302 && r.location === '/', `${p}: ${r.status}`)
  }
  assert.equal((await get('/')).status, 200, 'alive after a broken %-escape')
})

await s.close()
done('server')
