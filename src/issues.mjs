// Issues: find one's own by label, create, move along the template, comment, rewrite the text. Text is markdown; Jira
// gets ADF (adf.mjs). A move follows a path in the template's transition graph ("To Do → Design Review" goes through
// Design); every step is a transition Jira offers the issue right now.
import { markdownToAdf } from './adf.mjs'
import { FlowError } from './errors.mjs'
import { norm } from './template.mjs'

const enc = encodeURIComponent

// Own issue by its label: created before, but the host did not save the link — not created twice.
export async function findByLabel(jira, project, label) {
  const jql = `project = "${project}" AND labels = "${label}" ORDER BY created ASC`
  const r = await jira.get(`/rest/api/3/search/jql?jql=${enc(jql)}&fields=status,summary&maxResults=1`)
  const i = r?.issues?.[0]
  return i ? { id: i.id, key: i.key, status: i.fields?.status?.name || null } : null
}

export async function createIssue(jira, { project, type = 'Task', summary, body, labels = [] }) {
  const r = await jira.post('/rest/api/3/issue', { fields: { project: { key: project }, issuetype: { name: type }, summary: String(summary).slice(0, 255), description: markdownToAdf(body), labels } })
  return { id: r.id, key: r.key }
}

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
