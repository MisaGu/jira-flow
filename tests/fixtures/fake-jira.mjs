// An in-memory Jira for issue work (the client interface: get, post, put, site, cloudId): issues of one project,
// transitions from the template graph, search by label or by issue type (the parents of a project), the project's
// issue types, comments, text updates, parents. parents — issues one
// level up that may hold others ({ key, summary, project, type, level, status }); a parent that is not there is refused
// as Jira does (400, errors.parent). calls — every request made; an issue keeps the fields it was created with.
import assert from 'node:assert/strict'
import { FlowError } from '../../index.mjs'

export function fakeJira(tpl, { project = 'KEY', parents = [] } = {}) {
  const issues = new Map()
  const tops = new Map(parents.map((p) => [p.key, { summary: p.key, project, type: 'Epic', level: 1, status: 'To Do', ...p }]))
  const calls = []
  const keyOf = (route) => decodeURIComponent(/\/issue\/([^/?]+)/.exec(route)[1])
  const issue = (route) => issues.get(keyOf(route))
  const from = (st) => tpl.transitions.filter((t) => t.from === '*' || t.from === st)
  // The parent named in fields, if Jira would take it.
  const parentOf = (fields) => {
    const key = fields.parent?.key
    if (key && !tops.has(key)) throw new FlowError('JIRA', `Jira → 400: parent: ${key}`, { status: 400, data: { errorMessages: [], errors: { parent: `Could not find issue by id or key: ${key}` } } })
    return key || null
  }
  const withParent = (key) => (key ? { parent: { key } } : {})
  return {
    site: 'example.atlassian.net',
    cloudId: async () => '00000000-0000-4000-8000-000000000000',
    issues,
    calls,
    async get(route) {
      calls.push(`GET ${route.split('?')[0]}`)
      if (route.startsWith('/rest/api/3/project/')) return { id: '10000', key: project, issueTypes: [{ id: '10001', name: 'Epic', hierarchyLevel: 1 }, { id: '10002', name: 'Task', hierarchyLevel: 0 }] }
      if (route.startsWith('/rest/api/3/search/jql') && /issuetype in \(10001\)/.test(decodeURIComponent(route))) {
        const p = /project = "([^"]+)"/.exec(decodeURIComponent(route))[1]
        return { isLast: true, issues: [...tops.values()].filter((t) => t.project === p).map((t) => ({ id: `9${t.key.split('-')[1]}`, key: t.key, fields: { summary: t.summary, status: { name: t.status } } })) }
      }
      if (route.startsWith('/rest/api/3/search/jql')) {
        const lbl = /labels = "([^"]+)"/.exec(decodeURIComponent(route))[1]
        return { issues: [...issues.values()].filter((i) => i.labels.includes(lbl)).map((i) => ({ id: i.id, key: i.key, fields: { status: { name: i.status }, ...withParent(i.parent) } })) }
      }
      const t = tops.get(keyOf(route))
      if (t) return { id: `9${t.key.split('-')[1]}`, key: t.key, fields: { summary: t.summary, status: { name: t.status }, issuetype: { name: t.type, hierarchyLevel: t.level }, project: { key: t.project } } }
      const i = issue(route)
      if (!i) throw new FlowError('NOT_FOUND', `Jira GET ${route} → 404`, { status: 404 })
      if (route.includes('/transitions')) return { transitions: from(i.status).map((t, n) => ({ id: `${n}:${t.to}`, name: t.to, to: { name: t.to } })) }
      return { id: i.id, key: i.key, fields: { summary: i.summary, status: { name: i.status }, issuetype: { name: 'Task', hierarchyLevel: 0 }, project: { key: project }, ...withParent(i.parent) } }
    },
    async post(route, body) {
      calls.push(`POST ${route}`)
      if (route === '/rest/api/3/issue') {
        const parent = parentOf(body.fields)
        const key = `${project}-${issues.size + 1}`
        issues.set(key, { id: String(100 + issues.size), key, status: tpl.initial, labels: body.fields.labels, summary: body.fields.summary, description: body.fields.description, parent, comments: [], created: body.fields })
        return { id: issues.get(key).id, key }
      }
      const i = issue(route)
      if (route.endsWith('/transitions')) {
        const to = body.transition.id.split(':')[1]
        assert.ok(from(i.status).some((t) => t.to === to), `no transition ${i.status} → ${to}`)
        i.status = to
        return null
      }
      if (route.endsWith('/comment')) {
        i.comments.push(JSON.stringify(body.body))
        return { id: 'c' }
      }
      throw new Error(`unexpected POST ${route}`)
    },
    async put(route, body) {
      calls.push(`PUT ${route}`)
      const i = issue(route)
      const { parent, ...rest } = body.fields
      if (parent) i.parent = parentOf(body.fields)
      Object.assign(i, rest)
      return null
    },
  }
}
