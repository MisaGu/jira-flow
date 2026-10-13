// Issues: find one's own by label, create, read, move along the template, comment, rewrite the text, put under a parent.
// Text is markdown; Jira gets ADF (adf.mjs). A move follows a path in the template's transition graph ("To Do → Design
// Review" goes through Design); every step is a transition Jira offers the issue right now. A parent is an issue one
// level up (an epic for a task), set through the parent field.
import { markdownToAdf } from './adf.mjs'
import { fail, FlowError } from './errors.mjs'
import { KEY_RE } from './project.mjs'
import { norm } from './template.mjs'

const enc = encodeURIComponent

// An issue key: a project key (KEY_RE), a dash, a number — KEY-12.
export const ISSUE_KEY_RE = new RegExp(`^${KEY_RE.source.replace(/^\^|\$$/g, '')}-[1-9][0-9]*$`)

// Own issue by its label: created before, but the host did not save the link — not created twice.
export async function findByLabel(jira, project, label) {
  const jql = `project = "${project}" AND labels = "${label}" ORDER BY created ASC`
  const r = await jira.get(`/rest/api/3/search/jql?jql=${enc(jql)}&fields=status,summary,parent&maxResults=1`)
  const i = r?.issues?.[0]
  return i ? { id: i.id, key: i.key, status: i.fields?.status?.name || null, parent: i.fields?.parent?.key || null } : null
}

// parent — key of the issue to put the new one under (an epic for a task); none — no parent field at all.
export async function createIssue(jira, { project, type = 'Task', summary, body, labels = [], parent = null }) {
  const fields = { project: { key: project }, issuetype: { name: type }, summary: String(summary).slice(0, 255), description: markdownToAdf(body), labels, ...(parent ? { parent: { key: parent } } : {}) }
  const r = await jira.post('/rest/api/3/issue', { fields })
  return { id: r.id, key: r.key }
}

// One issue as a host needs it to pick a parent: its project, type and the type's level in the hierarchy (1 — an epic,
// 0 — a standard issue, -1 — a subtask; null — Jira did not say), status and own parent. Not there or not visible to
// the login — NOT_FOUND from the client.
export async function readIssue(jira, key) {
  if (!ISSUE_KEY_RE.test(String(key || ''))) fail('INPUT', `issue key must look like KEY-12, got ${JSON.stringify(key)}`)
  const r = await jira.get(`/rest/api/3/issue/${enc(key)}?fields=summary,status,issuetype,project,parent`)
  const f = r?.fields || {}
  return { id: r?.id || null, key: r?.key || key, summary: f.summary || '', status: f.status?.name || null, type: f.issuetype?.name || null, level: f.issuetype?.hierarchyLevel ?? null, project: f.project?.key || null, parent: f.parent?.key || null }
}

// The epics of a project to pick from: issues of its types one level above a task (the epic type is named differently
// on different sites), by key; at most max.
export async function listEpics(jira, project, { max = 500 } = {}) {
  const p = await jira.get(`/rest/api/3/project/${enc(project)}`)
  const types = (p?.issueTypes || []).filter((t) => t.hierarchyLevel === 1).map((t) => t.id)
  if (!types.length) return []
  const jql = `project = "${project}" AND issuetype in (${types.join(', ')}) ORDER BY key ASC`
  const out = []
  let next = null
  do {
    const r = await jira.get(`/rest/api/3/search/jql?jql=${enc(jql)}&fields=summary,status&maxResults=100${next ? `&nextPageToken=${enc(next)}` : ''}`)
    for (const i of r?.issues || []) out.push({ key: i.key, summary: i.fields?.summary || '', status: i.fields?.status?.name || null })
    next = r?.isLast === false ? r.nextPageToken || null : null
  } while (next && out.length < max)
  return out.slice(0, max)
}

// Put an issue under a parent (or under another one).
export const setParent = (jira, key, parent) => jira.put(`/rest/api/3/issue/${enc(key)}`, { fields: { parent: { key: parent } } })

// Jira refused the parent itself (gone, not visible, not one level up, another project) rather than the issue.
export const parentRefused = (e) => e?.status === 400 && (Object.keys(e.data?.errors || {}).some((k) => /^parent/i.test(k)) || (e.data?.errorMessages || []).some((m) => /parent/i.test(m)))

export async function statusOf(jira, key) {
  const r = await jira.get(`/rest/api/3/issue/${enc(key)}?fields=status`)
  return r?.fields?.status?.name || null
}

// A path in the template's transition graph: statuses after from up to to, inclusive; none — null. The flow comes
// first (status to status): Design Review → To Do goes through Design Approved, not through Backlog, which any status
// may reach; a "*" transition is taken only when the flow has no path.
export function pathTo(from, to, tpl) {
  if (norm(from) === norm(to)) return []
  const start = tpl.statuses.find((s) => norm(s.name) === norm(from))?.name || from
  for (const any of [false, true]) {
    const prev = new Map([[start, null]])
    const queue = [start]
    while (queue.length) {
      const cur = queue.shift()
      for (const t of tpl.transitions) {
        if (t.from !== cur && !(any && t.from === '*')) continue
        if (prev.has(t.to)) continue
        prev.set(t.to, cur)
        if (norm(t.to) === norm(to)) {
          const path = [t.to]
          for (let p = cur; p !== start; p = prev.get(p)) path.unshift(p)
          return path
        }
        queue.push(t.to)
      }
    }
  }
  return null
}

// Move the issue into status to, step by step along the template. Returns where from, where to and through what.
export async function moveTo(jira, key, to, tpl) {
  const from = await statusOf(jira, key)
  const path = pathTo(from, to, tpl)
  if (!path) throw new FlowError('NO_PATH', `the template has no path ${from} → ${to}`)
  let cur = from
  for (const next of path) {
    const r = await jira.get(`/rest/api/3/issue/${enc(key)}/transitions`)
    const t = (r?.transitions || []).find((x) => norm(x.to?.name) === norm(next))
    if (!t) throw new FlowError('NO_TRANSITION', `Jira offers ${key} no transition ${cur} → ${next}`)
    await jira.post(`/rest/api/3/issue/${enc(key)}/transitions`, { transition: { id: t.id } })
    cur = next
  }
  return { from, to, path }
}

export const addComment = (jira, key, md) => jira.post(`/rest/api/3/issue/${enc(key)}/comment`, { body: markdownToAdf(md) })

export const setText = (jira, key, { summary, body }) =>
  jira.put(`/rest/api/3/issue/${enc(key)}`, { fields: { ...(summary ? { summary: String(summary).slice(0, 255) } : {}), ...(body ? { description: markdownToAdf(body) } : {}) } })
