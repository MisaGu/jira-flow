// An in-memory Jira for issue work (the client interface: get, post, put, site, cloudId): issues of one project,
// transitions from the template graph, search only by label, comments, text updates. calls — every request made.
import assert from 'node:assert/strict'

export function fakeJira(tpl, { project = 'KEY' } = {}) {
  const issues = new Map()
  const calls = []
  const issue = (route) => issues.get(decodeURIComponent(/\/issue\/([^/?]+)/.exec(route)[1]))
  const from = (st) => tpl.transitions.filter((t) => t.from === '*' || t.from === st)
  return {
    site: 'example.atlassian.net',
    cloudId: async () => '00000000-0000-4000-8000-000000000000',
    issues,
    calls,
    async get(route) {
      calls.push(`GET ${route.split('?')[0]}`)
      if (route.startsWith('/rest/api/3/search/jql')) {
        const lbl = /labels = "([^"]+)"/.exec(decodeURIComponent(route))[1]
        return { issues: [...issues.values()].filter((i) => i.labels.includes(lbl)).map((i) => ({ id: i.id, key: i.key, fields: { status: { name: i.status } } })) }
      }
      const i = issue(route)
      if (route.includes('/transitions')) return { transitions: from(i.status).map((t, n) => ({ id: `${n}:${t.to}`, name: t.to, to: { name: t.to } })) }
      return { fields: { status: { name: i.status } } }
    },
    async post(route, body) {
      calls.push(`POST ${route}`)
      if (route === '/rest/api/3/issue') {
        const key = `${project}-${issues.size + 1}`
        issues.set(key, { id: String(100 + issues.size), key, status: tpl.initial, labels: body.fields.labels, summary: body.fields.summary, description: body.fields.description, comments: [] })
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
      Object.assign(issue(route), body.fields)
      return null
    },
  }
}
