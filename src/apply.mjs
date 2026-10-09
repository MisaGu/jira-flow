// The whole cycle on a project: inspect (check, plan, what applying would do, columns, people, roles), apply the
// template (board columns first — each brings its status — then statuses, transitions and role rules of the
// workflow, then the column order) and create a new project from the template. Only an empty team-managed Jira
// Software project takes a template: in a project with issues, changing the workflow moves them.
import { arrangeColumns, boardOps, planColumns, readColumns, wantedOrder } from './board.mjs'
import { checkProject, planFor, rulesItem, withCounts } from './check.mjs'
import { fail } from './errors.mjs'
import { createProject, KEY_RE, listProjects, readPeople, readProject } from './project.mjs'
import { rolesFor, rulesFor } from './template.mjs'
import { applyUpdate, buildUpdate, validate } from './workflow.mjs'

const READY_WAIT_MS = 30000

// Board columns against the template: what is there, what to create, what only a person can add, the order.
async function columnsPlan(jira, live, tpl) {
  if (!live.project.board) return null
  try {
    const { ari, columns } = await readColumns(jira, live.project.board.id)
    const ordered = wantedOrder(columns, tpl).every((c, i) => c.id === columns[i].id)
    return { ari, columns: columns.map((c) => c.name), ordered, ...planColumns(columns, tpl, new Set(live.raw.statuses.map((x) => x.name))), error: null }
  } catch (e) {
    return { ari: null, columns: [], ordered: null, create: [], manual: [], error: { code: e.code || 'JIRA', message: e.message } }
  }
}

const ready = (p) => p.kind === 'software' && p.managed === 'team'

// roles — the host's saved roles ({ <role>: { people, assign } }); missing people fall back to the login.
export async function inspect(jira, key, { template, roles: saved = {} }) {
  const live = await readProject(jira, key)
  const p = live.project
  const check = checkProject(p, template)
  let apply = null
  let people = null
  let roles = null
  if (ready(p)) {
    people = await readPeople(jira, key)
    roles = rolesFor(people, saved, template)
    const summary = buildUpdate(live.raw, template, rulesFor(roles, template, people.me.accountId)).summary
    check.items.push(rulesItem(summary.rulesChanged))
    apply = { ...summary, columns: await columnsPlan(jira, live, template), blocked: p.issues ? { code: 'NOT_EMPTY', vars: { count: p.issues } } : null }
  }
  const counted = withCounts(check)
  return { ...counted, plan: planFor(p, counted, { live: true }), apply, people, roles, project: p }
}

export async function applyTemplate(jira, key, { template, roles: saved = {}, dryRun = false, lang = 'en' }) {
  const live = await readProject(jira, key)
  if (!ready(live.project)) fail('NOT_TEAM_MANAGED', `${key} is not a team-managed Jira Software project`)
  if (live.project.issues) fail('NOT_EMPTY', `${key} has ${live.project.issues} issues; a template goes only into an empty project`, { count: live.project.issues })
  const people = await readPeople(jira, key)
  const roles = rolesFor(people, saved, template)
  const rules = rulesFor(roles, template, people.me.accountId)
  const board = await columnsPlan(jira, live, template)
  const cols = { create: board?.create || [], manual: board?.manual || [], ordered: board?.ordered ?? null, error: board?.error || null, created: [] }
  const base = { people, roles }
  if (dryRun) {
    const { payload, summary } = buildUpdate(live.raw, template, rules, { lang })
    return { dryRun: true, summary, columns: cols, ...base, ...(await validate(jira, payload)) }
  }
  let raw = live.raw
  if (cols.create.length) {
    const ops = boardOps(jira, board.ari)
    try {
      for (const name of cols.create) {
        await ops.create(name)
        cols.created.push(name)
      }
    } catch (e) {
      return { dryRun: false, applied: false, summary: buildUpdate(live.raw, template, rules, { lang }).summary, errors: [{ message: `board columns: ${e.message}`, transitionId: null }], warnings: [], columns: cols, ...base }
    }
    raw = (await readProject(jira, key)).raw
  }
  const { payload, summary } = buildUpdate(raw, template, rules, { lang })
  const r = summary.same ? { applied: true, errors: [], warnings: [] } : await applyUpdate(jira, payload)
  if (r.applied && board?.ari) {
    try {
      cols.ordered = (await arrangeColumns(boardOps(jira, board.ari), template)).ordered
    } catch (e) {
      Object.assign(cols, { ordered: false, error: { code: e.code || 'JIRA', message: e.message } })
    }
  }
  const after = r.applied ? await readProject(jira, key) : null
  return { dryRun: false, summary, ...r, columns: cols, check: after ? withCounts(checkProject(after.project, template)) : null, board: after?.project.board || null, ...base }
}

// A new empty team-managed project, then the template into it. Jira creates a project with a delay: wait until its
// board can be read.
export async function createFromTemplate(jira, { key, name, template, roles = {}, lang = 'en', waitMs = READY_WAIT_MS }) {
  key = String(key || '').trim().toUpperCase()
  if (!KEY_RE.test(key)) fail('INPUT', `project key must be 2–10 Latin letters and digits starting with a letter, got ${JSON.stringify(key)}`)
  name = String(name || '').trim().slice(0, 80) || key
  if ((await listProjects(jira)).some((p) => p.key === key)) fail('EXISTS', `project ${key} already exists`)
  const me = await jira.get('/rest/api/3/myself')
  await createProject(jira, { key, name, leadAccountId: me.accountId })
  const until = Date.now() + waitMs
  for (;;) {
    let board = null
    try {
      board = (await readProject(jira, key)).project.board
    } catch {
      // not readable yet
    }
    if (board || Date.now() > until) break
    await new Promise((ok) => setTimeout(ok, 2000))
  }
  return { created: key, name, ...(await applyTemplate(jira, key, { template, roles, lang })) }
}
