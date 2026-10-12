// The REST client with a fake fetch: Basic auth, error codes, the gateway after 401/403 on the site, cloudId; issue
// requests on the wire (read, parent on creation and later, the epics of a project page by page).
import { assert, check, done } from './harness.mjs'
import { createClient, siteCloudId } from '../src/client.mjs'
import { createIssue, listEpics, readIssue, setParent } from '../src/issues.mjs'

const CLOUD = '11111111-2222-4333-8444-555555555555'
const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body })
function fakeFetch(routes) {
  const seen = []
  const f = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body ? JSON.parse(init.body) : undefined })
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init)
    return reply(404, { errorMessages: ['nope'] })
  }
  f.seen = seen
  return f
}

await check('connection input: a site like name.atlassian.net, email and token are required', () => {
  assert.throws(() => createClient({ site: 'example.com', email: 'a@b.c', token: 't' }), (e) => e.code === 'INPUT')
  assert.throws(() => createClient({ site: 'x.atlassian.net', email: '', token: 't' }), (e) => e.code === 'NO_LOGIN')
})

await check('call: Basic auth to the site, JSON back; 404 → NOT_FOUND with the Jira message', async () => {
  const f = fakeFetch([[/\/rest\/api\/3\/myself$/, () => reply(200, { accountId: 'me' })]])
  const jira = createClient({ site: 'one.atlassian.net', email: 'a@b.c', token: 'tok', fetch: f })
  assert.deepEqual(await jira.get('/rest/api/3/myself'), { accountId: 'me' })
  assert.equal(f.seen[0].url, 'https://one.atlassian.net/rest/api/3/myself')
  assert.equal(f.seen[0].auth, `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`)
  await assert.rejects(jira.get('/rest/api/3/nope'), (e) => e.code === 'NOT_FOUND' && /nope/.test(e.message) && !/tok/.test(e.message))
})

await check('scoped token: the site says 401, the gateway by cloudId answers and is kept', async () => {
  const f = fakeFetch([
    [/two\.atlassian\.net\/_edge\/tenant_info/, () => reply(200, { cloudId: CLOUD })],
    [/^https:\/\/two\.atlassian\.net\/rest/, () => reply(401, { message: 'scoped' })],
    [new RegExp(`api\\.atlassian\\.com/ex/jira/${CLOUD}/rest`), () => reply(200, { ok: 1 })],
  ])
  const jira = createClient({ site: 'two.atlassian.net', email: 'a@b.c', token: 'tok', fetch: f })
  assert.deepEqual(await jira.get('/rest/api/3/project/search'), { ok: 1 })
  await jira.get('/rest/api/3/project/search')
  assert.equal(f.seen.filter((s) => s.url.startsWith('https://two.atlassian.net/rest')).length, 1)
  assert.equal(await jira.cloudId(), CLOUD)
})

await check('errors: refused everywhere → AUTH; no network → NETWORK; site without cloudId → NOT_FOUND', async () => {
  const f = fakeFetch([[/three\.atlassian\.net\/rest/, () => reply(403, {})]])
  const jira = createClient({ site: 'three.atlassian.net', email: 'a@b.c', token: 'tok', fetch: f })
  await assert.rejects(jira.get('/rest/api/3/myself'), (e) => e.code === 'AUTH' && e.status === 403)
  const down = createClient({ site: 'four.atlassian.net', email: 'a@b.c', token: 'tok', fetch: async () => { throw new Error('ECONNREFUSED') } })
  await assert.rejects(down.get('/rest/api/3/myself'), (e) => e.code === 'NETWORK')
  await assert.rejects(siteCloudId('five.atlassian.net', { fetch: async () => reply(200, {}) }), (e) => e.code === 'NOT_FOUND')
})

await check('issues on the wire: readIssue asks for the parent fields and reads the level; a parent goes as { key }', async () => {
  const epic = { id: '10070', key: 'KEY-7', fields: { summary: 'Screen · Sign in', status: { name: 'To Do' }, issuetype: { id: '10001', name: 'Epic', subtask: false, hierarchyLevel: 1 }, project: { id: '10000', key: 'KEY', name: 'Project' } } }
  const f = fakeFetch([
    [/\/rest\/api\/3\/issue\/KEY-7\?/, () => reply(200, epic)],
    [/\/rest\/api\/3\/issue$/, () => reply(201, { id: '10080', key: 'KEY-8' })],
    [/\/rest\/api\/3\/issue\/KEY-8$/, () => reply(204)],
  ])
  const jira = createClient({ site: 'six.atlassian.net', email: 'a@b.c', token: 'tok', fetch: f })
  assert.deepEqual(await readIssue(jira, 'KEY-7'), { id: '10070', key: 'KEY-7', summary: 'Screen · Sign in', status: 'To Do', type: 'Epic', level: 1, project: 'KEY', parent: null })
  assert.match(f.seen[0].url, /\/rest\/api\/3\/issue\/KEY-7\?fields=summary,status,issuetype,project,parent$/)
  assert.deepEqual(await createIssue(jira, { project: 'KEY', summary: 'S', body: 'B', labels: ['x'], parent: 'KEY-7' }), { id: '10080', key: 'KEY-8' })
  assert.deepEqual(f.seen[1].body.fields.parent, { key: 'KEY-7' })
  await createIssue(jira, { project: 'KEY', summary: 'S', body: 'B' })
  assert.equal('parent' in f.seen[2].body.fields, false)
  await setParent(jira, 'KEY-8', 'KEY-7')
  assert.deepEqual([f.seen[3].method, f.seen[3].body], ['PUT', { fields: { parent: { key: 'KEY-7' } } }])
})

await check('the epics of a project: by the types one level above a task, whatever their name; page by page', async () => {
  const page = (keys, next) => reply(200, { issues: keys.map((k) => ({ id: k, key: k, fields: { summary: `S ${k}`, status: { name: 'To Do' } } })), ...(next ? { isLast: false, nextPageToken: next } : { isLast: true }) })
  const f = fakeFetch([
    [/\/rest\/api\/3\/project\/KEY$/, () => reply(200, { id: '10000', key: 'KEY', issueTypes: [{ id: '20', name: 'Big', hierarchyLevel: 1 }, { id: '21', name: 'Task', hierarchyLevel: 0 }, { id: '22', name: 'Sub', hierarchyLevel: -1 }] })],
    [/nextPageToken=t2/, () => page(['KEY-9'])],
    [/\/rest\/api\/3\/search\/jql/, () => page(['KEY-3', 'KEY-4'], 't2')],
  ])
  const jira = createClient({ site: 'seven.atlassian.net', email: 'a@b.c', token: 'tok', fetch: f })
  assert.deepEqual((await listEpics(jira, 'KEY')).map((e) => [e.key, e.summary, e.status]), [['KEY-3', 'S KEY-3', 'To Do'], ['KEY-4', 'S KEY-4', 'To Do'], ['KEY-9', 'S KEY-9', 'To Do']])
  assert.match(decodeURIComponent(f.seen[1].url), /project = "KEY" AND issuetype in \(20\) ORDER BY key ASC/)
  assert.equal((await listEpics(jira, 'KEY', { max: 2 })).length, 2)
  const none = fakeFetch([[/\/rest\/api\/3\/project\/KEY$/, () => reply(200, { id: '1', key: 'KEY', issueTypes: [{ id: '21', name: 'Task', hierarchyLevel: 0 }] })]])
  assert.deepEqual(await listEpics(createClient({ site: 'seven.atlassian.net', email: 'a@b.c', token: 'tok', fetch: none }), 'KEY'), [])
  assert.equal(none.seen.length, 1, 'no epic type — no search')
})

done('client')
