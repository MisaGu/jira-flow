// A Jira project as it is now: kind, issue types, statuses, the workflow of each type with its transitions, board
// columns, issue count — for the check — and the raw workflows for the update (workflow.mjs). Also people, admin
// right, the project list and a new team-managed project. Read only, except createProject.
import { FlowError } from './errors.mjs'

export const CAT_IN = { TODO: 'new', IN_PROGRESS: 'indeterminate', DONE: 'done' }
export const CAT_OUT = { new: 'TODO', indeterminate: 'IN_PROGRESS', done: 'DONE' }
export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
// A new empty team-managed Jira Software project (kanban).
export const PROJECT_TEMPLATE = 'com.pyxis.greenhopper.jira:gh-simplified-agility-kanban'

export async function readProject(jira, key) {
  const p = await jira.get(`/rest/api/3/project/${encodeURIComponent(key)}`)
  // An epic is a container of work: its workflow is neither read nor touched.
  const types = (p.issueTypes || []).filter((t) => t.hierarchyLevel !== 1)
  const wf = await jira.post('/rest/api/3/workflows', { projectAndIssueTypes: types.map((t) => ({ projectId: String(p.id), issueTypeId: String(t.id) })) })
  const statuses = (wf.statuses || []).map((s) => ({ id: s.id, ref: s.statusReference || s.id, name: s.name, category: CAT_IN[s.statusCategory] || 'new', description: s.description || '' }))
  const nameOf = (ref) => statuses.find((s) => s.ref === ref || s.id === ref)?.name || ref
  const workflows = (wf.workflows || []).map((w) => ({
    id: w.id,
    name: w.name,
    editable: w.isEditable !== false,
    statuses: (w.statuses || []).map((s) => nameOf(s.statusReference)),
    initial: nameOf((w.transitions || []).find((t) => t.type === 'INITIAL')?.toStatusReference),
    transitions: (w.transitions || []).flatMap((t) =>
      t.type === 'GLOBAL' ? [{ from: '*', to: nameOf(t.toStatusReference) }] : t.type === 'DIRECTED' ? (t.links || []).map((l) => ({ from: nameOf(l.fromStatusReference), to: nameOf(t.toStatusReference) })) : [],
    ),
  }))
  let issues = null
  try {
    issues = (await jira.post('/rest/api/3/search/approximate-count', { jql: `project = "${p.key}"` })).count
  } catch {
    // the count is optional
  }
  let board = null
  try {
    const b = (await jira.get(`/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(p.key)}`)).values?.[0]
    if (b) {
      const cfg = await jira.get(`/rest/agile/1.0/board/${b.id}/configuration`)
      board = { id: b.id, name: b.name, columns: (cfg.columnConfig?.columns || []).map((c) => c.name) }
    }
  } catch {
    // business projects have no Jira Software boards
  }
  // Statuses of the project — those in its workflows; transitions for the check — the poorest workflow.
  const used = new Set(workflows.flatMap((w) => w.statuses))
  const poorest = workflows.reduce((a, w) => (!a || w.transitions.length < a.transitions.length ? w : a), null)
  return {
    project: {
      key: p.key,
      name: p.name,
      kind: p.projectTypeKey,
      managed: p.style === 'next-gen' ? 'team' : 'company',
      lead: p.lead?.displayName || '',
      issues,
      types: types.map((t) => t.name),
      statuses: statuses.filter((s) => used.has(s.name)).map(({ name, category }) => ({ name, category })),
      transitions: poorest ? poorest.transitions : null,
      initial: poorest?.initial || null,
      workflows: workflows.map(({ name, editable, statuses: st, transitions }) => ({ name, editable, statuses: st.length, transitions: transitions.length })),
      board,
    },
    raw: { id: String(p.id), wf, statuses },
  }
}

export async function isAdmin(jira) {
  try {
    return Boolean((await jira.get('/rest/api/3/mypermissions?permissions=ADMINISTER')).permissions?.ADMINISTER?.havePermission)
  } catch {
    return null
  }
}

// People of a project: the login the module works as, who can be assigned (people only, no apps), admin or not.
export async function readPeople(jira, key) {
  const me = await jira.get('/rest/api/3/myself')
  let users = []
  try {
    users = ((await jira.get(`/rest/api/3/user/assignable/search?project=${encodeURIComponent(key)}&maxResults=200`)) || []).filter((u) => u.accountType === 'atlassian' && u.active !== false).map((u) => ({ accountId: u.accountId, name: u.displayName }))
  } catch {
    // no project yet — nobody to assign but the login
  }
  if (!users.some((u) => u.accountId === me.accountId)) users.unshift({ accountId: me.accountId, name: me.displayName })
  return { me: { accountId: me.accountId, name: me.displayName }, users, admin: await isAdmin(jira) }
}

export async function listProjects(jira) {
  const r = await jira.get('/rest/api/3/project/search?expand=lead,insight&maxResults=100')
  return (r.values || []).map((p) => ({ key: p.key, name: p.name, kind: p.projectTypeKey, managed: p.style === 'next-gen' ? 'team' : 'company', lead: p.lead?.displayName || '', issues: p.insight?.totalIssueCount ?? null }))
}

// Only a Jira admin can create a project.
export async function createProject(jira, { key, name, leadAccountId }) {
  if (!KEY_RE.test(String(key || ''))) throw new FlowError('INPUT', `project key must be 2–10 Latin letters and digits starting with a letter, got ${JSON.stringify(key)}`)
  return jira.post('/rest/api/3/project', { key, name, projectTypeKey: 'software', projectTemplateKey: PROJECT_TEMPLATE, leadAccountId, assigneeType: 'UNASSIGNED' })
}
