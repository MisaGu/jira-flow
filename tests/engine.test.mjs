// The engine on a host in memory: the login checked before it is saved, the template work shaped for a person (Jira
// operations replaced by stubs), roles, the space — its Jira project and epic, the sync of items into an in-memory Jira
// — and every result and event against the contract.
import { assert, check, done } from './harness.mjs'
import { fakeJira } from './fixtures/fake-jira.mjs'
import { createFlow, enums, loadTemplate, schema, textOf, validate, validateRef } from '../index.mjs'
import { rolesFor } from '../src/template.mjs'

const T = loadTemplate('design-dev')
// What a person reads in Russian — from the locale, so the test holds no other script (K1).
const ru = (key, vars) => textOf(key, 'ru', vars)
const fits = (value, def) => assert.deepEqual(validateRef(value, 'calls', def), [], def)
const fitsEvent = (data) => assert.deepEqual(validate({ event: 'jira', data }, schema('events')), [], JSON.stringify(data))

// A host in memory: the same shape as localHost, with what it was asked to save.
function memHost({ login = { site: 'example.atlassian.net', email: 'me@example.com', token: 'tok' }, items = [] } = {}) {
  const h = {
    name: 'memory',
    saved: { login, roles: {}, link: {}, sync: { on: false, since: null }, links: {}, items },
    account: {
      get: () => h.saved.login,
      save: (l) => (h.saved.login = { ...l, source: 'memory' }),
      forget: () => (h.saved.login = null),
      view: () => ({ extra: true }),
    },
    roles: { get: (site, key) => h.saved.roles[`${site}/${key}`] || {}, save: (site, key, v) => (h.saved.roles[`${site}/${key}`] = v) },
    space: {
      id: 'space-1',
      link: { get: (site) => h.saved.link[site] || null, set: (site, v) => (h.saved.link[site] = v) },
      sync: { get: () => h.saved.sync, set: (p) => (h.saved.sync = { ...h.saved.sync, ...p }) },
      links: {
        get: (site, id) => h.saved.links[site]?.[id] || null,
        put: (site, id, p) => ((h.saved.links[site] ??= {})[id] = { ...h.saved.links[site]?.[id], ...p }),
        all: (site) => h.saved.links[site] || {},
      },
      items: (id = null) => (id === null ? h.saved.items : h.saved.items.filter((i) => i.id === id)),
    },
  }
  return h
}
const myself = (status = 200) => async () => ({ ok: status < 300, status, text: async () => JSON.stringify(status < 300 ? { accountId: 'a1', displayName: 'Me' } : { message: 'no' }) })
const people = { me: { accountId: 'a1', name: 'Me' }, users: [{ accountId: 'a1', name: 'Me' }, { accountId: 'a2', name: 'Two' }], admin: true }
const stubs = (extra = {}) => ({
  listProjects: async () => [{ key: 'KEY', name: 'Key', kind: 'software', managed: 'team' }],
  isAdmin: async () => true,
  cloudId: async () => '00000000-0000-4000-8000-000000000000',
  readPeople: async () => people,
  ...extra,
})

await check('login: checked against Jira before it is saved; a wrong site or no token — a text for a person', async () => {
  const host = memHost({ login: null })
  const flow = createFlow({ host, lang: 'ru', fetch: myself(), ops: stubs(), autostart: false })
  const none = await flow.overview()
  fits(none, 'overview')
  assert.deepEqual([none.account.token, none.connected, none.projects.length], [false, false, 0])
  await assert.rejects(flow.login({ site: 'example.com', email: 'a@b.c', token: 't' }), (e) => e.code === 'INPUT' && flow.said(e) === ru('error.site'))
  await assert.rejects(flow.login({ site: 'one.atlassian.net', email: '', token: 't' }), (e) => e.code === 'NO_LOGIN' && flow.said(e) === ru('error.login'))
  const after = await flow.login({ site: 'https://One.Atlassian.net/jira', email: ' me@example.com ', token: ' tok ' })
  fits(after, 'overview')
  assert.deepEqual(host.saved.login, { site: 'one.atlassian.net', email: 'me@example.com', token: 'tok', source: 'memory' })
  assert.deepEqual([after.account.site, after.account.token, after.account.extra, after.connected, after.projects[0].url], ['one.atlassian.net', true, true, true, 'https://one.atlassian.net/jira/core/projects/KEY/board'])
  assert.ok(!JSON.stringify(after).includes('tok"'), 'the token never leaves')
  const refused = createFlow({ host: memHost({ login: null }), fetch: myself(401), ops: stubs(), autostart: false })
  await assert.rejects(refused.login({ site: 'two.atlassian.net', email: 'a@b.c', token: 'bad' }), (e) => e.code === 'AUTH')
  assert.equal((await flow.logout()).account.token, false)
})

await check('check, apply, a new project: shaped for a person in lang, by the contract', async () => {
  const r = {
    items: [{ key: 'statuses', state: 'ok', code: 'check.statuses.ok', vars: { total: 10 } }, { key: 'board', state: 'bad', code: 'check.board.missing', vars: { name: 'B', names: ['Design'] }, fix: { code: 'fix.board.columns', vars: { names: ['Design'] } } }],
    plan: [{ key: 'board', code: 'fix.board.columns', vars: { names: ['Design'] }, via: 'api' }],
    ok: 1, warn: 0, bad: 1, unknown: 0,
    apply: { same: false, created: ['Design'], changed: [{ from: 'To Do', to: 'To Do', category: 'new' }], added: 3, dropped: 0, initialMoved: false, rulesChanged: 2, initial: 'To Do', columns: { create: ['Design'], error: null }, blocked: { code: 'NOT_EMPTY', vars: { count: 2 } } },
    people,
    roles: rolesFor(people, {}, T),
    project: { key: 'KEY', name: 'Key', issues: 2, workflows: [], initial: 'Backlog', board: { id: 5, name: 'B', columns: [] } },
  }
  const applied = { applied: true, dryRun: false, summary: r.apply, errors: [{ message: 'x', transitionId: '7' }], warnings: [], columns: { create: [], error: null }, people, roles: rolesFor(people, {}, T), board: { id: 5 } }
  const seen = []
  const flow = createFlow({ host: memHost(), lang: 'ru', ops: stubs({ inspect: async (_, key) => (seen.push(key), r), applyTemplate: async (_, key, o) => (seen.push([key, o.dryRun]), applied), createFromTemplate: async (_, o) => ({ ...applied, created: o.key, name: o.name }) }), autostart: false })
  const c = await flow.check({ project: 'key' })
  fits(c, 'check')
  assert.equal(seen[0], 'KEY')
  assert.equal(c.items[1].fix.what.length > 0, true)
  assert.equal(c.apply.changed[0], `To Do${ru('apply.category', { category: enums.category.label('new', 'ru') })}`)
  assert.match(c.apply.blocked, /2/)
  assert.equal(c.project.url, 'https://example.atlassian.net/jira/software/projects/KEY/boards/5')
  const a = await flow.apply({ project: 'KEY', dryRun: true })
  fits(a, 'applied')
  assert.deepEqual(seen[1], ['KEY', true])
  assert.deepEqual(a.errors, [ru('apply.transition', { message: 'x', id: '7' })])
  assert.equal(a.people, undefined)
  const n = await flow.create({ key: 'new', name: '' })
  fits(n, 'applied')
  assert.deepEqual([n.created, n.name], ['NEW', 'NEW'])
  await assert.rejects(flow.check({ project: '1x' }), (e) => e.code === 'INPUT' && flow.said(e) === ru('error.project_key', { key: '1x' }))
  await assert.rejects(createFlow({ host: memHost({ login: null }), ops: stubs(), autostart: false }).check({ project: 'KEY' }), (e) => e.code === 'NO_LOGIN')
})

await check('roles: people of the project only, at least one in a role; saved by the host per site and project', async () => {
  const host = memHost()
  const flow = createFlow({ host, lang: 'ru', ops: stubs(), autostart: false })
  const v = await flow.roles({ project: 'KEY' })
  fits(v, 'roles')
  assert.equal(v.single, false)
  await assert.rejects(flow.saveRoles({ project: 'KEY', roles: { dev: { people: ['nobody'], assign: null } } }), (e) => flow.said(e) === ru('error.role_empty', { role: enums.role.label('dev', 'ru') }))
  const saved = await flow.saveRoles({ project: 'KEY', roles: { dev: { people: ['a2', 'nobody'], assign: 'nobody' } } })
  fits(saved, 'roles')
  assert.deepEqual(host.saved.roles['example.atlassian.net/KEY'].dev, { people: ['a2'], assign: 'a2' })
  assert.equal(saved.roles.find((r) => r.key === 'dev').assignName, 'Two')
})

const EPICS = { parents: [{ key: 'KEY-90', summary: 'Screen · Sign in' }, { key: 'KEY-91', summary: 'Frame' }, { key: 'KEY-92', summary: 'Plans' }, { key: 'OTHER-1', summary: 'Other', project: 'OTHER' }] }
const item = (id, status = 'Design Review', extra = {}) => ({ id, summary: `Item ${id}`, body: '## Short\nText', status, notes: [{ id: `ready:${id}`, text: 'ready' }], firstAt: '2026-10-01T10:00:00Z', view: { shown: id }, ...extra })
function spaceSetup(opts = {}) {
  const jira = fakeJira(T, EPICS)
  const host = memHost({ items: [item('a'), item('b', 'Design'), item('c')] })
  const events = []
  const flow = createFlow({ host, lang: 'ru', client: () => jira, ops: stubs({ readIssue: async (_, key) => { const r = await jira.get(`/rest/api/3/issue/${key}?fields=summary`); return { id: r.id, key: r.key, summary: r.fields.summary, status: r.fields.status?.name, type: r.fields.issuetype?.name, level: r.fields.issuetype?.hierarchyLevel, project: r.fields.project?.key, parent: r.fields.parent?.key || null } } }), emit: (e, d) => events.push([e, d]), settleMs: 5, autostart: false, ...opts })
  return { jira, host, flow, events }
}

await check('space: the Jira project of the space; the epic is checked in Jira and belongs to the project', async () => {
  const { host, flow } = spaceSetup()
  fits(flow.state(), 'state')
  assert.deepEqual(flow.state(), { on: false, since: null, site: 'example.atlassian.net', project: null, epic: null })
  await assert.rejects(flow.setEpic({ epic: 'KEY-90' }), (e) => flow.said(e) === ru('error.no_project'))
  fits(flow.setLink({ project: 'key' }), 'state')
  await assert.rejects(flow.setEpic({ epic: 'sign-in' }), (e) => flow.said(e) === ru('error.epic_key', { project: 'KEY', raw: 'sign-in' }))
  await assert.rejects(flow.setEpic({ epic: 'KEY-99' }), (e) => flow.said(e) === ru('error.epic_missing', { key: 'KEY-99' }))
  await assert.rejects(flow.setEpic({ epic: 'OTHER-1' }), (e) => flow.said(e) === ru('error.epic_project', { key: 'OTHER-1', other: 'OTHER', project: 'KEY' }))
  const set = await flow.setEpic({ epic: ' key-90 ' })
  fits(set, 'epicSet')
  assert.deepEqual([set.epic, set.epicInfo.summary, set.epicInfo.ok], ['KEY-90', 'Screen · Sign in', true])
  fits(await flow.epic(), 'epic')
  flow.setLink({ project: 'KEY' })
  assert.equal(host.saved.link['example.atlassian.net'].epic, 'KEY-90', 'the same project keeps the epic')
  flow.setLink({ project: 'OTHER' })
  assert.deepEqual(host.saved.link['example.atlassian.net'], { project: 'OTHER' }, 'another project drops it')
  host.saved.link['example.atlassian.net'] = { project: 'KEY', epic: 'KEY-77' }
  const gone = await flow.epic()
  assert.deepEqual([gone.key, gone.ok], ['KEY-77', false])
  assert.equal(gone.problem, ru('error.epic_missing', { key: 'KEY-77' }))
  assert.equal((await flow.setEpic({ epic: '' })).epic, null)
})

await check('sync: on with the chosen items, others wait; new ones go by themselves under the epic; events by the contract', async () => {
  const { jira, host, flow, events } = spaceSetup()
  flow.setLink({ project: 'KEY' })
  await flow.setEpic({ epic: 'KEY-90' })
  assert.throws(() => createFlow({ host: memHost({ login: null }), autostart: false }).setSync({ on: true }), (e) => e.code === 'INPUT' && /No Jira project/.test(e.text))
  const v = flow.setSync({ on: true, ids: ['a'] })
  fits(v, 'sync')
  await flow.idle()
  assert.equal(jira.issues.size, 1)
  const a = host.saved.links['example.atlassian.net'].a
  assert.deepEqual([a.key, a.parent, host.saved.links['example.atlassian.net'].b.skip], ['KEY-1', 'KEY-90', true])
  assert.deepEqual(jira.issues.get('KEY-1').created.parent, { key: 'KEY-90' })
  host.saved.items.push(item('d', 'Design', { firstAt: new Date(Date.now() + 1000).toISOString() }))
  flow.changed(['d', 'c'])
  await flow.idle()
  assert.equal(host.saved.links['example.atlassian.net'].d.key, 'KEY-2', 'a new item goes by itself')
  assert.equal(host.saved.links['example.atlassian.net'].c.skip, true, 'an old one waits')
  fits(flow.add({ id: 'b' }), 'sync')
  await flow.idle()
  assert.equal(jira.issues.get(host.saved.links['example.atlassian.net'].b.key).status, 'Design')
  await assert.rejects(Promise.resolve().then(() => flow.add({ id: 'zzz' })), (e) => flow.said(e) === ru('error.no_item', { id: 'zzz' }))
  const f = flow.feed()
  fits(f, 'feed')
  assert.deepEqual([f.total, f.linked, f.byStatus['Design Review'], f.items.find((x) => x.id === 'a').shown], [4, 3, 2, 'a'])
  assert.equal(f.items.find((x) => x.id === 'a').jira.parent, 'KEY-90')
  assert.ok(events.length && events.every(([e]) => e === 'jira'))
  for (const [, d] of events) fitsEvent(d)
  assert.equal(await flow.rewrite('a', { summary: 'Full', body: '## Goal\nText' }), true)
  assert.equal(jira.issues.get('KEY-1').summary, 'Full')
  fits(flow.setSync({ on: false }), 'sync')
  const n = jira.calls.length
  flow.changed('a')
  await flow.idle()
  assert.equal(jira.calls.length, n, 'off — nothing is written')
  flow.close()
})

await check('epics by level: the own epic of an item, else of its group, else of the space; null — none; only the issues a change touches move', async () => {
  const { jira, host, flow } = spaceSetup()
  const site = 'example.atlassian.net'
  for (const i of host.saved.items) i.group = i.id === 'c' ? 'two' : 'one'
  host.space.groups = () => [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }, { id: 'three', title: 'Three' }]
  flow.setLink({ project: 'KEY' })
  await flow.setEpic({ epic: 'KEY-90' })
  await assert.rejects(flow.setEpic({ epic: 'KEY-91', group: 'nope' }), (e) => flow.said(e) === ru('error.no_group', { id: 'nope' }))
  await assert.rejects(flow.setEpic({ epic: 'KEY-91', group: 'one', id: 'a' }), (e) => flow.said(e) === ru('error.epic_target'))
  await assert.rejects(flow.setEpic({ epic: 'KEY-91', id: 'zzz' }), (e) => flow.said(e) === ru('error.no_item', { id: 'zzz' }))
  await assert.rejects(flow.setEpic({ epic: 'OTHER-1', group: 'one' }), (e) => flow.said(e) === ru('error.epic_project', { key: 'OTHER-1', other: 'OTHER', project: 'KEY' }))
  const set = await flow.setEpic({ epic: 'key-91', group: 'one' })
  fits(set, 'epicSet')
  assert.deepEqual([set.epic, set.epicInfo.key], ['KEY-90', 'KEY-91'], 'the space keeps its epic')
  fits(await flow.setEpic({ epic: '', group: 'two' }), 'epicSet')
  await flow.setEpic({ epic: 'KEY-92', id: 'b' })
  assert.deepEqual(host.saved.link[site], { project: 'KEY', epic: 'KEY-90', epics: { groups: { one: 'KEY-91', two: null }, items: { b: 'KEY-92' } } })
  const m = await flow.epics()
  fits(m, 'epicMap')
  assert.deepEqual(m.list.map((e) => [e.key, e.url]), [['KEY-90', 'https://example.atlassian.net/browse/KEY-90'], ['KEY-91', 'https://example.atlassian.net/browse/KEY-91'], ['KEY-92', 'https://example.atlassian.net/browse/KEY-92']])
  assert.deepEqual(m.groups.map((g) => [g.id, g.title, g.items, g.epic, g.own]), [['one', 'One', 2, 'KEY-91', 'KEY-91'], ['two', 'Two', 1, null, null], ['three', 'Three', 0, 'KEY-90', undefined]])
  assert.deepEqual([m.epic, m.items, m.missing], ['KEY-90', { b: 'KEY-92' }, []])

  flow.setSync({ on: true, ids: ['a', 'b', 'c'] })
  await flow.idle()
  const L = host.saved.links[site]
  assert.deepEqual(['a', 'b', 'c'].map((id) => jira.issues.get(L[id].key).parent), ['KEY-91', 'KEY-92', null])
  const f = flow.feed()
  fits(f, 'feed')
  assert.deepEqual(['a', 'b', 'c'].map((id) => f.items.find((x) => x.id === id).epic), [{ key: 'KEY-91', from: 'group' }, { key: 'KEY-92', from: 'item' }, { key: null, from: 'group' }])
  assert.equal(f.items.find((x) => x.id === 'c').group, 'two')

  let n = jira.calls.length
  await flow.setEpic({ epic: '', id: 'b', inherit: true })
  await flow.idle()
  assert.deepEqual([jira.issues.get(L.b.key).parent, host.saved.link[site].epics.items], ['KEY-91', {}])
  assert.deepEqual(jira.calls.slice(n).filter((c) => c.startsWith('PUT')), [`PUT /rest/api/3/issue/${L.b.key}`], 'only b moves')
  n = jira.calls.length
  await flow.setEpic({ epic: 'KEY-90', group: 'two' })
  await flow.idle()
  assert.equal(jira.issues.get(L.c.key).parent, 'KEY-90')
  assert.deepEqual(jira.calls.slice(n).filter((c) => c.startsWith('PUT')), [`PUT /rest/api/3/issue/${L.c.key}`], 'only the group moves')
  n = jira.calls.length
  await flow.setEpic({ epic: '', group: 'one' })
  await flow.idle()
  assert.deepEqual([jira.issues.get(L.a.key).parent, jira.calls.length], ['KEY-91', n], 'no epic: an issue stays where it is')

  host.saved.link[site].epics.items.b = 'KEY-77'
  assert.deepEqual((await flow.epics()).missing, [{ key: 'KEY-77', problem: ru('error.epic_gone', { key: 'KEY-77', project: 'KEY' }) }])
  flow.setLink({ project: 'KEY' })
  assert.equal(host.saved.link[site].epics.groups.two, 'KEY-90', 'the same project keeps the choices')
  flow.setLink({ project: 'OTHER' })
  assert.deepEqual(host.saved.link[site], { project: 'OTHER' }, 'another project drops them')
  flow.close()
})

await check('an item the engine cannot take: the error is in its link and an event; the queue goes on', async () => {
  const { host, flow, events } = spaceSetup()
  flow.setLink({ project: 'KEY' })
  flow.setSync({ on: true, ids: ['a'] })
  host.saved.items.push(item('bad', 'Nope', { firstAt: new Date(Date.now() + 1000).toISOString() }))
  flow.changed('bad')
  await flow.idle()
  assert.equal(host.saved.links['example.atlassian.net'].bad.error.code, 'INPUT')
  assert.ok(events.some(([, d]) => d.type === 'error' && d.id === 'bad'))
  assert.ok(host.saved.links['example.atlassian.net'].a.key)
  flow.close()
})

await check('an issue the space did not create: comment first, then the steps — only from the named statuses, in the project, with the sync on', async () => {
  const { jira, host, flow, events } = spaceSetup()
  const put = (key, status) => jira.issues.set(key, { id: `5${key.split('-')[1]}`, key, status, labels: [], summary: key, comments: [] })
  const ask = (key, steps = ['AI Testing', 'Human Testing']) => ({ key, from: ['In Progress', 'AI Testing', 'Human Testing'], steps, comment: '## Tests passed' })
  put('KEY-31', 'In Progress')
  flow.setLink({ project: 'KEY' })
  const off = await flow.moveIssue(ask('KEY-31'))
  fits(off, 'issueMoved')
  assert.deepEqual([off.state, off.reason, off.text], ['skipped', 'sync_off', ru('move.sync_off', { key: 'KEY-31' })])
  host.saved.sync = { on: true, since: new Date(Date.now() + 60000).toISOString() }
  const n = jira.calls.length
  const r = await flow.moveIssue(ask('key-31'))
  fits(r, 'issueMoved')
  assert.deepEqual([r.state, r.from, r.to, r.path], ['moved', 'In Progress', 'Human Testing', ['AI Testing', 'Human Testing']])
  const i = jira.issues.get('KEY-31')
  assert.equal(i.status, 'Human Testing')
  assert.equal(i.comments.length, 1)
  assert.match(jira.calls.slice(n).find((c) => c.startsWith('POST')), /\/comment$/, 'the comment goes before the move')
  const again = await flow.moveIssue(ask('KEY-31'))
  assert.deepEqual([again.state, again.from, again.path], ['kept', 'Human Testing', []])
  assert.equal(i.comments.length, 2)
  const back = await flow.moveIssue(ask('KEY-31', ['In Progress']))
  assert.deepEqual([back.state, back.to], ['moved', 'In Progress'])
  put('KEY-40', 'Done')
  const done = await flow.moveIssue(ask('KEY-40', ['In Progress']))
  fits(done, 'issueMoved')
  assert.deepEqual([done.state, done.reason, done.from, jira.issues.get('KEY-40').status, jira.issues.get('KEY-40').comments.length], ['skipped', 'status', 'Done', 'Done', 0])
  const other = await flow.moveIssue(ask('OTHER-31'))
  assert.deepEqual([other.state, other.reason], ['skipped', 'project'])
  await assert.rejects(flow.moveIssue({ key: 'KEY', from: ['In Progress'], steps: [] }), (e) => e.code === 'INPUT' && flow.said(e) === ru('error.issue_key', { key: 'KEY' }))
  await assert.rejects(flow.moveIssue({ key: 'KEY-31', from: ['Doing'], steps: [] }), (e) => e.code === 'INPUT' && flow.said(e) === ru('error.status', { status: 'Doing' }))
  for (const [, d] of events) fitsEvent(d)
  assert.ok(events.some(([, d]) => d.type === 'moved' && d.key === 'KEY-31'))
  flow.close()
})

await check('a host without a space: the template work only; a space call — a clear error', async () => {
  const host = memHost()
  delete host.space
  const flow = createFlow({ host, ops: stubs(), autostart: false })
  fits(await flow.overview(), 'overview')
  assert.throws(() => flow.feed(), (e) => e.code === 'INPUT')
  assert.throws(() => createFlow({ host: {} }), (e) => e.code === 'INPUT')
})

done('engine')
