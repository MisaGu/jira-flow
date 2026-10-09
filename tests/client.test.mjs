// The REST client with a fake fetch: Basic auth, error codes, the gateway after 401/403 on the site, cloudId.
import { assert, check, done } from './harness.mjs'
import { createClient, siteCloudId } from '../index.mjs'

const CLOUD = '11111111-2222-4333-8444-555555555555'
const reply = (status, body) => ({ ok: status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body })
function fakeFetch(routes) {
  const seen = []
  const f = async (url, init = {}) => {
    seen.push({ url, method: init.method || 'GET', auth: init.headers?.authorization })
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

done('client')
