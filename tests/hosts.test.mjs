// localHost: the login in two files (the token only in secrets.json, mode 600), forgetting it, roles by site and
// project, the space — its link by site and the sync switch, links by site, items put through the API keep the moment
// they were first seen.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assert, check, done } from './harness.mjs'
import { localHost } from '../index.mjs'

const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'jira-flow-host-'))
const h = localHost({ home, name: 'test' })
const read = (f) => JSON.parse(fs.readFileSync(path.join(home, f), 'utf8'))

await check('login: site and email in login.json, the token only in secrets.json (mode 600); forget drops both', () => {
  assert.equal(h.account.get(), null)
  h.account.save({ site: 'example.atlassian.net', email: 'me@example.com', token: 'tok-1' })
  assert.deepEqual(h.account.get(), { site: 'example.atlassian.net', email: 'me@example.com', token: 'tok-1', source: 'local' })
  assert.deepEqual(read('login.json'), { site: 'example.atlassian.net', email: 'me@example.com' })
  assert.equal(fs.statSync(path.join(home, 'secrets.json')).mode & 0o777, 0o600)
  h.account.forget()
  assert.equal(h.account.get(), null)
  assert.deepEqual(read('secrets.json').tokens, {})
  assert.equal(fs.existsSync(path.join(home, 'login.json')), false)
})

await check('roles by site and project; the space: link by site, the sync switch, links by site', () => {
  h.roles.save('example.atlassian.net', 'KEY', { dev: { people: ['a1'], assign: 'a1' } })
  assert.deepEqual(h.roles.get('example.atlassian.net', 'KEY'), { dev: { people: ['a1'], assign: 'a1' } })
  assert.deepEqual(h.roles.get('other.atlassian.net', 'KEY'), {})
  h.space.link.set('example.atlassian.net', { project: 'KEY', epic: 'KEY-7' })
  assert.deepEqual([h.space.link.get('example.atlassian.net'), h.space.link.get('other.atlassian.net')], [{ project: 'KEY', epic: 'KEY-7' }, null])
  assert.deepEqual(h.space.sync.get(), { on: false, since: null })
  h.space.sync.set({ on: true, since: '2026-10-01T00:00:00Z' })
  h.space.sync.set({ on: false })
  assert.deepEqual(h.space.sync.get(), { on: false, since: '2026-10-01T00:00:00Z' })
  h.space.links.put('example.atlassian.net', 'a', { key: 'KEY-1' })
  h.space.links.put('example.atlassian.net', 'a', { applied: 'Design' })
  const l = h.space.links.get('example.atlassian.net', 'a')
  assert.deepEqual([l.key, l.applied, typeof l.at], ['KEY-1', 'Design', 'string'])
  assert.deepEqual(Object.keys(h.space.links.all('example.atlassian.net')), ['a'])
  assert.equal(h.space.id, fs.realpathSync(home))
})

await check('items: put adds new ones and replaces known ones by id; firstAt stays from the first time', () => {
  assert.deepEqual(h.space.items(), [])
  assert.deepEqual(h.space.put([{ id: 'a', summary: 'A', status: 'Design' }, { id: 'b', summary: 'B', status: 'Design' }]), ['a', 'b'])
  const first = h.space.items('a')[0].firstAt
  h.space.put([{ id: 'a', summary: 'A2', status: 'Design Review' }])
  const a = h.space.items('a')[0]
  assert.deepEqual([a.summary, a.status, a.firstAt, h.space.items().length], ['A2', 'Design Review', first, 2])
})

await check('no home: INPUT before anything is written', () => {
  assert.throws(() => localHost({}), (e) => e.code === 'INPUT')
})

done('hosts')
