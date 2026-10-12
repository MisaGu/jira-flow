// The sync engine on an in-memory Jira: an issue per item, status along the template path, notes as comments once,
// own issue found by label, the latest push wins, retry on network trouble, rewrite of the text, the issue under a
// parent (on creation and later, a parent Jira refuses does not stop the issue), readIssue.
import { assert, check, done } from './harness.mjs'
import { fakeJira } from './fixtures/fake-jira.mjs'
import { markdownToAdf } from '../src/adf.mjs'
import { FlowError } from '../src/errors.mjs'
import { ISSUE_KEY_RE, pathTo, readIssue } from '../src/issues.mjs'
import { createSync } from '../src/sync.mjs'
import { loadTemplate } from '../src/template.mjs'

const T = loadTemplate('design-dev')
const memStore = () => {
  const links = new Map()
  return { links, get: (id) => links.get(id) || null, put: (id, patch) => (links.set(id, { ...links.get(id), ...patch }), links.get(id)) }
}
const setup = (opts = {}, jiraOpts = {}) => {
  const jira = fakeJira(T, jiraOpts)
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
  assert.throws(() => sync.push({ id: 'b', summary: 'S', status: 'Design', parent: 'key-1' }), (e) => e.code === 'INPUT')
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

const puts = (jira) => jira.calls.filter((c) => c.startsWith('PUT')).length
const EPICS = { parents: [{ key: 'KEY-90', summary: 'Screen · Sign in' }, { key: 'KEY-91', summary: 'Screen · Menu' }] }

await check('parent: the issue is created under it in the same request; the link keeps it; nothing written twice', async () => {
  const { jira, store, events, sync } = setup({}, EPICS)
  sync.push({ id: 'a', summary: 'S', status: 'Design', parent: 'KEY-90' })
  await sync.idle()
  const i = jira.issues.get('KEY-1')
  assert.deepEqual(i.created.parent, { key: 'KEY-90' })
  assert.equal(i.parent, 'KEY-90')
  assert.equal(store.get('a').parent, 'KEY-90')
  sync.push({ id: 'a', summary: 'S', status: 'Design Review', parent: 'KEY-90' })
  await sync.idle()
  assert.equal(puts(jira), 0)
  assert.deepEqual(events.map((e) => e.type), ['created', 'moved', 'moved'])
})

await check('parent later: an issue made without one gets it on the next push; another parent moves it; none leaves it', async () => {
  const { jira, store, events, sync } = setup({}, EPICS)
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  const i = jira.issues.get('KEY-1')
  assert.equal('parent' in i.created, false, 'no parent field without a parent')
  assert.equal(store.get('a').parent, null)
  sync.push({ id: 'a', summary: 'S', status: 'Design', parent: 'KEY-90' })
  await sync.idle()
  assert.equal(i.parent, 'KEY-90')
  assert.deepEqual(events.at(-1), { type: 'parent', id: 'a', key: 'KEY-1', parent: 'KEY-90' })
  sync.push({ id: 'a', summary: 'S', status: 'Design', parent: 'KEY-91' })
  await sync.idle()
  assert.equal(i.parent, 'KEY-91')
  sync.push({ id: 'a', summary: 'S', status: 'Design' })
  await sync.idle()
  assert.deepEqual([i.parent, store.get('a').parent, puts(jira)], ['KEY-91', 'KEY-91', 2])
})

await check('a parent Jira refuses: the issue goes in without it, status and notes keep up, comments are not repeated', async () => {
  const { jira, store, events, sync } = setup({}, EPICS)
  sync.push({ id: 'a', summary: 'S', status: 'Design Review', parent: 'KEY-99', notes: [{ id: 'n1', text: 'one' }] })
  await sync.idle()
  const i = jira.issues.get('KEY-1')
  assert.deepEqual([jira.issues.size, i.status, i.parent, 'parent' in i.created], [1, 'Design Review', null, false])
  assert.equal(store.get('a').error.code, 'JIRA')
  assert.match(store.get('a').error.message, /parent/)
  assert.deepEqual(events.filter((e) => e.type === 'error').map((e) => [e.code, e.retry]), [['JIRA', false]])
  const notes = [{ id: 'n1', text: 'one' }, { id: 'n2', text: 'two' }]
  sync.push({ id: 'a', summary: 'S', status: 'To Do', parent: 'KEY-99', notes })
  await sync.idle()
  sync.push({ id: 'a', summary: 'S', status: 'To Do', parent: 'KEY-99', notes })
  await sync.idle()
  assert.equal(i.status, 'To Do')
  assert.equal(i.comments.length, 1, 'n2 once, though the parent step failed after it')
  assert.deepEqual(store.get('a').seen, ['n1', 'n2'])
  sync.push({ id: 'a', summary: 'S', status: 'To Do', parent: 'KEY-90', notes })
  await sync.idle()
  assert.deepEqual([i.parent, store.get('a').parent, store.get('a').error], ['KEY-90', 'KEY-90', null])
})

await check('own issue by label: its parent is read from Jira, not written again', async () => {
  const { jira, store, sync } = setup({}, EPICS)
  sync.push({ id: 'a', summary: 'S', status: 'Design', parent: 'KEY-90' })
  await sync.idle()
  store.links.delete('a')
  sync.push({ id: 'a', summary: 'S', status: 'Design', parent: 'KEY-90' })
  await sync.idle()
  assert.deepEqual([jira.issues.size, store.get('a').parent, puts(jira)], [1, 'KEY-90', 0])
})

await check('readIssue: project, type, level and status of an issue; a bad key — INPUT; none — NOT_FOUND', async () => {
  const jira = fakeJira(T, EPICS)
  assert.deepEqual(await readIssue(jira, 'KEY-90'), { id: '990', key: 'KEY-90', summary: 'Screen · Sign in', status: 'To Do', type: 'Epic', level: 1, project: 'KEY', parent: null })
  await assert.rejects(readIssue(jira, 'key-90'), (e) => e.code === 'INPUT')
  await assert.rejects(readIssue(jira, 'KEY-5'), (e) => e.code === 'NOT_FOUND')
  assert.deepEqual(['KEY-12', 'AB1-7', 'KEY-0', 'key-1', 'K-1', 'KEY12'].map((k) => ISSUE_KEY_RE.test(k)), [true, true, false, false, false, false])
})

done('sync')
