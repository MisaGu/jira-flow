// Template, project check, plan, workflow update, roles and rules, board columns — pure functions, no Jira.
import { assert, check, done } from './harness.mjs'
import { blockedFor } from '../src/apply.mjs'
import { arrangeColumns, planColumns, wantedOrder } from '../src/board.mjs'
import { checkProject, describe, planFor } from '../src/check.mjs'
import { describeTemplate, loadTemplate, rolesFor, rulesFor, validateTemplate } from '../src/template.mjs'
import { buildUpdate } from '../src/workflow.mjs'

const T = loadTemplate('design-dev')
const CYR = /\p{Script=Cyrillic}/u

// A project as Jira returns it: 7 statuses, To Do and To Do (Approved) in the "in progress" category, a global
// transition into every status instead of a flow, new issues start in Backlog.
const NAMES = [['Backlog', 'new'], ['To Do', 'indeterminate'], ['To Do (Approved)', 'indeterminate'], ['In Progress', 'indeterminate'], ['AI Testing', 'indeterminate'], ['Human Testing', 'indeterminate'], ['Done', 'done']]
const raw = () => ({
  id: '10001',
  statuses: NAMES.map(([name, category], i) => ({ id: String(i + 1), ref: String(i + 1), name, category, description: '' })),
  wf: {
    workflows: [
      {
        id: 'wf-1',
        version: { id: 'ver-1', versionNumber: 4 },
        statuses: NAMES.map((_, i) => ({ statusReference: String(i + 1), properties: {} })),
        transitions: [{ id: '1', type: 'INITIAL', name: 'Create', links: [], toStatusReference: '1' }, ...NAMES.map((_, i) => ({ id: String(11 + i * 10), type: 'GLOBAL', name: NAMES[i][0], links: [], toStatusReference: String(i + 1) }))],
      },
    ],
  },
})
const P = { key: 'KEY', kind: 'software', managed: 'team', issues: 0, types: ['Task', 'Bug', 'Story'], statuses: NAMES.map(([name, category]) => ({ name, category })), transitions: NAMES.map(([to]) => ({ from: '*', to })), initial: 'Backlog', board: { name: 'KEY board', columns: NAMES.map(([n]) => n) } }

await check('template: valid; design before development; Done only after Human Testing', () => {
  validateTemplate(T)
  const names = T.statuses.map((s) => s.name)
  assert.deepEqual(names.slice(1, 5), ['Design', 'Design Review', 'Design Approved', 'To Do'])
  assert.deepEqual(T.transitions.filter((t) => t.to === 'Done').map((t) => t.from), ['Human Testing'])
  assert.throws(() => validateTemplate({ ...T, initial: 'Nope' }), (e) => e.code === 'INPUT')
  assert.throws(() => loadTemplate('nope'), (e) => e.code === 'INPUT')
})

await check('template texts: every status, role and type has English and Russian text', () => {
  for (const lang of ['en', 'ru']) {
    const d = describeTemplate(T, lang)
    for (const x of [...d.statuses, ...d.roles, ...d.types]) assert.ok(x.about && !x.about.startsWith('template.'), `${lang}: ${x.name || x.key}`)
    assert.ok(!d.title.startsWith('template.'))
  }
  assert.match(describeTemplate(T, 'ru').roles[0].title, CYR)
})

await check('check: missing design statuses, categories, transitions, initial status, columns — codes and fixes', () => {
  const c = checkProject(P, T)
  const by = Object.fromEntries(c.items.map((i) => [i.key, i]))
  assert.equal(by.statuses.state, 'bad')
  assert.deepEqual(by.statuses.vars.names, ['Design', 'Design Review', 'Design Approved'])
  assert.equal(by.categories.state, 'warn')
  assert.equal(by.transitions.state, 'bad')
  assert.equal(by.initial.state, 'warn')
  assert.equal(by.board.state, 'warn')
  const plan = planFor(P, c, { live: true })
  assert.ok(plan.every((p) => p.via === 'api'))
  assert.equal(planFor({ ...P, managed: 'company' }, c, { live: true }).find((p) => p.key === 'board').via, 'manual')
  const ru = describe({ ...c, plan }, 'ru').items.find((i) => i.key === 'statuses').text
  assert.ok(CYR.test(ru) && ru.includes('Design, Design Review, Design Approved'), ru)
  assert.equal(describe(c, 'en').items.find((i) => i.key === 'statuses').title, 'Statuses')
})

await check('issues in the project: information while it follows the template, a limit while something is to fix', () => {
  const fit = { ...P, issues: 2, statuses: T.statuses.map(({ name, category }) => ({ name, category })), transitions: T.transitions, initial: T.initial, board: { name: 'B', columns: T.columns } }
  const ok = checkProject(fit, T).items.find((i) => i.key === 'issues')
  assert.deepEqual([ok.state, ok.code], ['ok', 'check.issues.follow'])
  const limits = checkProject({ ...P, issues: 2 }, T).items.find((i) => i.key === 'issues')
  assert.deepEqual([limits.state, limits.code], ['warn', 'check.issues.limits'])
  assert.equal(checkProject(P, T).items.find((i) => i.key === 'issues').state, 'ok')
})

await check('update: new statuses get UUIDs, categories fixed, transitions and initial status follow the template', () => {
  const { payload, summary } = buildUpdate(raw(), T)
  assert.deepEqual(summary.created, ['Design', 'Design Review', 'Design Approved'])
  assert.equal(summary.changed.length, 2)
  assert.deepEqual(summary.changed[0], { from: 'To Do', to: 'To Do', category: 'new' })
  for (const s of payload.statuses.filter((x) => !x.id)) assert.match(s.statusReference, /^[0-9a-f-]{36}$/)
  assert.equal(payload.statuses.find((s) => s.name === 'Design').description, 'a design version is being made')
  assert.match(buildUpdate(raw(), T, null, { lang: 'ru' }).payload.statuses.find((s) => s.name === 'Design').description, CYR)
  const ref = Object.fromEntries(payload.statuses.map((s) => [s.statusReference, s.name]))
  const [w] = payload.workflows
  assert.deepEqual(w.version, { id: 'ver-1', versionNumber: 4 })
  const init = w.transitions.filter((t) => t.type === 'INITIAL')
  assert.equal(ref[init[0].toStatusReference], 'To Do')
  const pairs = w.transitions.flatMap((t) => (t.type === 'GLOBAL' ? [`*>${ref[t.toStatusReference]}`] : t.type === 'DIRECTED' ? t.links.map((l) => `${ref[l.fromStatusReference]}>${ref[t.toStatusReference]}`) : []))
  assert.deepEqual(pairs.sort(), T.transitions.map((t) => `${t.from}>${t.to}`).sort())
  assert.equal(w.transitions.find((t) => t.type === 'GLOBAL').id, '11')
  assert.equal(summary.dropped, 6)
})

// The project after the update, as Jira would return it: for "applying again changes nothing".
function after(payload) {
  const statuses = payload.statuses.map((x, i) => ({ id: x.id || `n${i}`, ref: x.id || `n${i}`, name: x.name, category: { TODO: 'new', IN_PROGRESS: 'indeterminate', DONE: 'done' }[x.statusCategory], description: '' }))
  const to = new Map(payload.statuses.map((x, i) => [x.statusReference, x.id || `n${i}`]))
  const w = payload.workflows[0]
  return { statuses, wf: { workflows: [{ ...w, statuses: w.statuses.map((x) => ({ ...x, statusReference: to.get(x.statusReference) })), transitions: w.transitions.map((t) => ({ ...t, toStatusReference: to.get(t.toStatusReference), links: t.links.map((l) => ({ ...l, fromStatusReference: to.get(l.fromStatusReference) })) })) }] } }
}

await check('update again on an updated project — nothing new', () => {
  const { summary } = buildUpdate(after(buildUpdate(raw(), T).payload), T)
  assert.deepEqual([summary.created, summary.changed, summary.added, summary.dropped, summary.same], [[], [], 0, 0, true])
})

const R = (people, assign = people[0]) => ({ people, assign })

await check('project with issues: rules, transitions and order go in; new statuses, categories or columns do not', () => {
  const s = buildUpdate(raw(), T).summary
  assert.equal(blockedFor({ issues: 0 }, s, { create: ['Design'] }), null)
  assert.deepEqual(blockedFor({ issues: 3 }, s, { create: [] }), { code: 'NOT_EMPTY', vars: { count: 3 } })
  const same = buildUpdate(after(buildUpdate(raw(), T).payload), T, rulesFor({ design: R(['d1']), lead: R(['l1']), dev: R(['v1']), qa: R(['q1']) }, T, 'svc')).summary
  assert.ok(same.rulesChanged > 0)
  assert.equal(blockedFor({ issues: 3 }, same, { create: [] }), null)
  assert.ok(blockedFor({ issues: 3 }, same, { create: ['Design'] }))
})

await check('roles: one person in Jira holds every role; saved roles keep only people of the project', () => {
  const alone = { me: { accountId: 'admin', name: 'Admin' }, users: [{ accountId: 'admin', name: 'Admin' }] }
  assert.deepEqual(Object.values(rolesFor(alone, {}, T)), T.roles.map(() => R(['admin'])))
  const team = { me: alone.me, users: [...alone.users, { accountId: 'u2', name: 'Ann' }, { accountId: 'u3', name: 'Bob' }] }
  const roles = rolesFor(team, { dev: 'u2', qa: { people: ['gone', 'u3', 'u2'], assign: 'gone' }, lead: { people: ['u2', 'u3'], assign: null }, design: { people: ['gone'] } }, T)
  assert.deepEqual(roles.dev, R(['u2']))
  assert.deepEqual(roles.qa, R(['u3', 'u2'], 'u3'))
  assert.deepEqual(roles.lead, R(['u2', 'u3'], null))
  assert.deepEqual(roles.design, R(['admin']))
  const rules = rulesFor(roles, T, 'admin')
  assert.deepEqual(rules.assign['In Progress'], { type: 'to-selected-user', accountId: 'u2' })
  assert.deepEqual(rules.assign['To Do'], { type: 'to-unassigned' })
  assert.equal(rules.assign.Done, undefined)
  assert.deepEqual(rules.restrict.Done, ['u3', 'u2', 'admin'])
})

await check('rules in the update: assignees by role and gates; other rules stay; again — no change', () => {
  const rules = rulesFor({ design: R(['d1']), lead: R(['l1', 'l2'], null), dev: R(['v1']), qa: R(['q1', 'q2']) }, T, 'svc')
  const r0 = raw()
  r0.wf.workflows[0].transitions[1].actions = [{ ruleKey: 'system:update-field', parameters: { fieldId: 'labels' } }]
  const { payload, summary } = buildUpdate(r0, T, rules)
  const ref = Object.fromEntries(payload.statuses.map((x) => [x.statusReference, x.name]))
  const into = (name) => payload.workflows[0].transitions.filter((t) => ref[t.toStatusReference] === name && t.type !== 'INITIAL')
  const assignee = (name) => into(name).map((t) => t.actions.find((a) => a.ruleKey === 'system:change-assignee')?.parameters)
  assert.deepEqual(assignee('Design Review'), [{ type: 'to-selected-user', accountId: 'd1' }])
  assert.deepEqual(assignee('To Do'), [{ type: 'to-unassigned' }])
  assert.equal(into('Done')[0].conditions.conditions.find((c) => c.ruleKey === 'system:restrict-issue-transition').parameters.accountIds, 'q1,q2,svc')
  assert.ok(into('Backlog')[0].actions.some((a) => a.ruleKey === 'system:update-field'))
  assert.ok(summary.rulesChanged > 0)
  const again = after(payload)
  assert.equal(buildUpdate(again, T, rules).summary.same, true)
  assert.ok(buildUpdate(again, T, rulesFor({ design: R(['d1']), lead: R(['l1', 'l2'], 'l1'), dev: R(['v1']), qa: R(['q1', 'q2']) }, T, 'svc')).summary.rulesChanged > 0)
})

await check('columns: created where no status of that name exists; a status without a column — for a person', () => {
  const cols = NAMES.map(([name], i) => ({ id: String(122 + i), name }))
  assert.deepEqual(planColumns(cols, T, new Set(NAMES.map(([n]) => n))), { create: ['Design', 'Design Review', 'Design Approved'], manual: [] })
  assert.deepEqual(planColumns(cols, T, new Set([...NAMES.map(([n]) => n), 'Design'])), { create: ['Design Review', 'Design Approved'], manual: ['Design'] })
})

// A fake board: rank(id, position) counts positions from base (0 or 1), as Jira may.
function fakeBoard(names, base) {
  let cols = names.map((name, i) => ({ id: `c${i}`, name }))
  const calls = []
  return {
    calls,
    names: () => cols.map((c) => c.name),
    read: async () => cols.map((c) => ({ ...c })),
    rank: async (id, pos) => {
      calls.push([id, pos])
      const c = cols.find((x) => x.id === id)
      cols = cols.filter((x) => x !== c)
      cols.splice(Math.max(0, Math.min(cols.length, pos - base)), 0, c)
      return { success: true }
    },
  }
}

await check('column order: new columns go after Backlog whether Jira counts from 0 or from 1', async () => {
  const start = [...NAMES.map(([n]) => n).slice(0, -1), 'Design', 'Design Review', 'Design Approved', 'Done']
  for (const base of [0, 1]) {
    const b = fakeBoard(start, base)
    assert.equal((await arrangeColumns(b, T)).ordered, true, `base ${base}`)
    assert.deepEqual(b.names(), T.columns, `base ${base}`)
  }
  const ready = fakeBoard(T.columns, 0)
  assert.equal((await arrangeColumns(ready, T)).ordered, true)
  assert.equal(ready.calls.length, 0)
  assert.deepEqual(wantedOrder([{ id: 'x', name: 'Other' }, { id: 'b', name: 'Done' }, { id: 'a', name: 'Backlog' }], T).map((c) => c.id), ['a', 'b', 'x'])
})

done('template')
