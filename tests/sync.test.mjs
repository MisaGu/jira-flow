// The sync engine on an in-memory Jira: an issue per item, status along the template path, notes as comments once,
// own issue found by label, the latest push wins, retry on network trouble, rewrite of the text.
import { assert, check, done } from './harness.mjs'
import { fakeJira } from './fixtures/fake-jira.mjs'
import { createSync, FlowError, loadTemplate, markdownToAdf, pathTo } from '../index.mjs'

const T = loadTemplate('design-dev')
const memStore = () => {
  const links = new Map()
  return { links, get: (id) => links.get(id) || null, put: (id, patch) => (links.set(id, { ...links.get(id), ...patch }), links.get(id)) }
}
const setup = (opts = {}) => {
  const jira = fakeJira(T)
  const store = memStore()
  const events = []
  const sync = createSync({ client: () => jira, project: 'KEY', template: T, store, scope: 'space-1', prefix: 'host', onEvent: (e) => events.push(e), ...opts })
  return { jira, store, events, sync }
}

await check('path: through the flow first (Design Approved, not Backlog); "*" only when the flow has none', () => {
  assert.deepEqual(pathTo('To Do', 'Design Review', T), ['Design', 'Design Review'])
  assert.deepEqual(pathTo('Design Review', 'To Do', T), ['Design Approved', 'To Do'])
  assert.deepEqual(pathTo('To Do (Approved)', 'Human Testing', T), ['In Progress', 'Human Testing'])
  assert.deepEqual(pathTo('Human Testing', 'Backlog', T), ['Backlog'])
  assert.deepEqual(pathTo('Done', 'Done', T), [])
})

await check('push: issue created with labels, moved To Do → Design → Design Review, link and events', async () => {
  const { jira, store, events, sync } = setup()
  sync.push({ id: 'a', summary: 'Header redesign', body: '## Short\nText', status: 'Design Review', notes: [{ id: 'ready:v1', text: 'v1 ready' }] })
  await sync.idle()
  const i = jira.issues.get('KEY-1')
  assert.equal(i.status, 'Design Review')
  assert.deepEqual(i.labels, ['host', sync.label('a')])
  assert.match(sync.label('a'), /^host-[0-9a-f]{12}$/)
  assert.deepEqual(i.description, markdownToAdf('## Short\nText'))
  assert.equal(i.comments.length, 0, 'notes present at creation count as seen')
  const l = store.get('a')
  assert.deepEqual([l.key, l.applied, l.seen, l.error], ['KEY-1', 'Design Review', ['ready:v1'], null])
  assert.deepEqual(events.map((e) => e.type), ['created', 'moved'])
  assert.deepEqual(events[1].path, ['Design', 'Design Review'])
})

await check('next push: new notes become comments once; status follows; the latest push wins', async () => {
  const { jira, sync } = setup()
  sync.push({ id: 'a', summary: 'S', status: 'Design Review', notes: [{ id: 'ready:v1', text: 'v1' }] })
  await sync.idle()
  sync.push({ id: 'a', summary: 'S', status: 'Design', notes: [{ id: 'ready:v1', text: 'v1' }] }, 1000)
  sync.push({ id: 'a', summary: 'S', status: 'To Do', notes: [{ id: 'ready:v1', text: 'v1' }, { id: 'main:v1', text: 'Main version **v1**' }] }, 1000)
  await sync.idle()
  const i = jira.issues.get('KEY-1')
  assert.equal(i.status, 'To Do')
  assert.equal(i.comments.length, 1)
  assert.match(i.comments[0], /Main version/)
  assert.ok(jira.calls.filter((c) => c.startsWith('POST') && c.endsWith('/transitions')).length >= 4, 'through Design Approved')
})

await check('own issue by label: the link was lost — no second issue', async () => {
  const { jira, store, sync } = setup()
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  store.links.delete('a')
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  assert.equal(jira.issues.size, 1)
  assert.equal(store.get('a').key, 'KEY-1')
})

await check('network trouble: error in the link and an event, a retry later succeeds', async () => {
  const { jira, store, events, sync } = setup({ retryMs: [1] })
  const post = jira.post
  let failOnce = true
  jira.post = async (route, body) => {
    if (failOnce && route === '/rest/api/3/issue') {
      failOnce = false
      throw new FlowError('NETWORK', 'down')
    }
    return post(route, body)
  }
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  assert.equal(events[0].type, 'error')
  assert.deepEqual([events[0].code, events[0].retry], ['NETWORK', true])
  await new Promise((ok) => setTimeout(ok, 20))
  await sync.idle()
  assert.equal(jira.issues.get('KEY-1').status, 'Design')
  assert.equal(store.get('a').error, null)
})

await check('no login: error NO_LOGIN, no retry; bad item: INPUT at once', async () => {
  const store = memStore()
  const events = []
  const sync = createSync({ client: () => null, project: 'KEY', template: T, store, onEvent: (e) => events.push(e) })
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  assert.deepEqual([events[0].code, events[0].retry], ['NO_LOGIN', false])
  assert.throws(() => sync.push({ id: 'b', summary: 'S', status: 'Nope' }), (e) => e.code === 'INPUT')
  assert.throws(() => createSync({ client: () => null, project: 'KEY', template: T, store, prefix: 'Bad Prefix' }), (e) => e.code === 'INPUT')
})

await check('rewrite: the same issue gets the new summary and body', async () => {
  const { jira, events, sync } = setup()
  sync.push({ id: 'a', summary: 'Short', status: 'Design' })
  await sync.idle()
  assert.equal(await sync.rewrite('a', { summary: 'Full title', body: '## Goal\nFull text' }), true)
  assert.equal(jira.issues.get('KEY-1').summary, 'Full title')
  assert.equal(events.at(-1).type, 'text')
  assert.equal(await sync.rewrite('nope', { summary: 'x' }), false)
})

done('sync')
