// A template into a team-managed project with one POST /rest/api/3/workflows/update: missing statuses are created in
// the same request (a new UUID in statusReference), existing ones get the template name and category, the
// transitions of every workflow become the template's, a new issue starts in the template's initial status. Jira
// validates first (/workflows/update/validation). Statuses outside the template stay: removing a status moves its
// issues, and that is a person's call.
import { randomUUID } from 'node:crypto'
import { textOf } from './lang.mjs'
import { CAT_OUT } from './project.mjs'
import { norm } from './template.mjs'

const TASK_WAIT_MS = 60000
const ASSIGN = 'system:change-assignee'
const RESTRICT = 'system:restrict-issue-transition'

// Rules of a transition into status to (rulesFor): assign to the role's person, let into a gate only the role and the
// service. Other rules of the transition stay; these two are replaced. changed — Jira had them otherwise.
function withRules(t, to, rules) {
  if (!rules) return { t, changed: false }
  const key = (p) => (p ? `${p.type}:${p.type === 'to-selected-user' ? p.accountId : ''}` : null)
  const oldAssign = key((t.actions || []).find((a) => a.ruleKey === ASSIGN)?.parameters)
  const oldRestrict = (t.conditions?.conditions || []).find((c) => c.ruleKey === RESTRICT)?.parameters?.accountIds || null
  const want = rules.assign[to] || null
  const assign = key(want)
  const restrict = rules.restrict[to]?.length ? rules.restrict[to].join(',') : null
  const actions = (t.actions || []).filter((a) => a.ruleKey !== ASSIGN)
  if (want) actions.push({ ruleKey: ASSIGN, parameters: want.type === 'to-selected-user' ? { type: want.type, accountId: want.accountId } : { type: want.type } })
  const conds = (t.conditions?.conditions || []).filter((c) => c.ruleKey !== RESTRICT)
  if (restrict) conds.push({ ruleKey: RESTRICT, parameters: { accountIds: restrict } })
  const conditions = conds.length || t.conditions?.conditionGroups?.length ? { operation: t.conditions?.operation || 'ALL', conditions: conds, conditionGroups: t.conditions?.conditionGroups || [] } : t.conditions
  return { t: { ...t, actions, ...(conditions ? { conditions } : {}) }, changed: oldAssign !== assign || oldRestrict !== restrict }
}

// raw — readProject().raw; rules — rulesFor() or null (transition rules untouched); lang — language of the
// descriptions of new statuses.
export function buildUpdate(raw, tpl, rules = null, { lang = 'en' } = {}) {
  const created = []
  const changed = []
  const about = (name) => textOf(`template.${tpl.id}.status.${name}`, lang)
  const top = tpl.statuses.map((s) => {
    const ex = raw.statuses.find((x) => x.name === s.name) || raw.statuses.find((x) => norm(x.name) === norm(s.name))
    const statusCategory = CAT_OUT[s.category]
    if (!ex) {
      created.push(s.name)
      return { statusReference: randomUUID(), name: s.name, statusCategory, description: about(s.name) }
    }
    if (ex.name !== s.name || ex.category !== s.category) changed.push({ from: ex.name, to: s.name, ...(ex.category !== s.category ? { category: s.category } : {}) })
    return { id: ex.id, statusReference: ex.ref, name: s.name, statusCategory, description: ex.description || about(s.name) }
  })
  const ref = Object.fromEntries(tpl.statuses.map((s, i) => [s.name, top[i].statusReference]))
  let dropped = 0
  let added = 0
  let initialMoved = 0
  let rulesChanged = 0
  const ruled = (t, to) => {
    const r = withRules(t, to, rules)
    if (r.changed) rulesChanged++
    return r.t
  }
  const workflows = raw.wf.workflows.map((w) => {
    const old = w.transitions || []
    let next = old.reduce((m, t) => Math.max(m, Number(t.id) || 0), 0)
    const keep = new Set(Object.values(ref))
    // Statuses of the workflow: all template statuses and the old ones outside it (their issues stay where they are).
    const statuses = [...tpl.statuses.map((s) => ({ statusReference: ref[s.name], properties: {} })), ...(w.statuses || []).filter((s) => !keep.has(s.statusReference)).map((s) => ({ statusReference: s.statusReference, properties: s.properties || {} }))]
    const init = old.find((t) => t.type === 'INITIAL')
    if (init?.toStatusReference !== ref[tpl.initial]) initialMoved++
    const transitions = [init ? { ...init, toStatusReference: ref[tpl.initial] } : { id: '1', type: 'INITIAL', name: 'Create', links: [], toStatusReference: ref[tpl.initial], actions: [], validators: [], triggers: [], properties: {} }]
    // One directed transition per target status, linked from every template status that leads there. An old
    // transition into the same status keeps its id and rules; only its links change.
    const targets = [...new Set(tpl.transitions.map((t) => t.to))]
    const was = (from, to) => old.some((t) => (from === '*' ? t.type === 'GLOBAL' : t.type === 'DIRECTED' && (t.links || []).some((l) => l.fromStatusReference === ref[from])) && t.toStatusReference === ref[to])
    for (const to of targets) {
      const froms = tpl.transitions.filter((t) => t.to === to)
      added += froms.filter((t) => !was(t.from, t.to)).length
      if (froms.some((t) => t.from === '*')) {
        const g = old.find((t) => t.type === 'GLOBAL' && t.toStatusReference === ref[to])
        transitions.push(ruled(g ? { ...g } : { id: String(++next), type: 'GLOBAL', name: to, description: '', toStatusReference: ref[to], links: [], actions: [], validators: [], triggers: [], properties: {} }, to))
      }
      const direct = froms.filter((t) => t.from !== '*')
      if (!direct.length) continue
      const d = old.find((t) => t.type === 'DIRECTED' && t.toStatusReference === ref[to])
      const links = direct.map((t) => d?.links?.find((l) => l.fromStatusReference === ref[t.from]) || { fromStatusReference: ref[t.from], fromPort: 0, toPort: 1 })
      transitions.push(ruled(d ? { ...d, links } : { id: String(++next), type: 'DIRECTED', name: to, description: '', toStatusReference: ref[to], links, actions: [], validators: [], triggers: [], properties: {} }, to))
    }
    // What Jira had and the template has not goes away (links and whole transitions).
    const now = new Set(tpl.transitions.map((t) => `${t.from === '*' ? '*' : ref[t.from]}>${ref[t.to]}`))
    for (const t of old) {
      if (t.type === 'GLOBAL' && !now.has(`*>${t.toStatusReference}`)) dropped++
      if (t.type === 'DIRECTED') dropped += (t.links || []).filter((l) => !now.has(`${l.fromStatusReference}>${t.toStatusReference}`)).length
    }
    return { id: w.id, version: w.version, statuses, transitions, ...(w.startPointLayout ? { startPointLayout: w.startPointLayout } : {}) }
  })
  // same — the workflow already follows the template: nothing to write (applying then only orders the columns).
  const same = !created.length && !changed.length && !added && !dropped && !initialMoved && !rulesChanged
  return { payload: { statuses: top, workflows }, summary: { created, changed, added, dropped, initialMoved, rulesChanged, rules: Boolean(rules), same, workflows: workflows.length, initial: tpl.initial } }
}

// Jira's own validation messages, errors apart from warnings.
function validation(v) {
  const list = (v?.errors || []).map((e) => ({ level: e.level, message: e.message, transitionId: e.elementReference?.transitionId || null }))
  const strip = ({ message, transitionId }) => ({ message, transitionId })
  return { errors: list.filter((e) => e.level !== 'WARNING').map(strip), warnings: list.filter((e) => e.level === 'WARNING').map(strip) }
}

export async function validate(jira, payload) {
  return validation(await jira.post('/rest/api/3/workflows/update/validation', { payload, validationOptions: { levels: ['ERROR', 'WARNING'] } }))
}

// Validate, then update; a long change runs as a Jira task — wait for it.
export async function applyUpdate(jira, payload) {
  const v = await validate(jira, payload)
  if (v.errors.length) return { applied: false, ...v }
  const r = await jira.post('/rest/api/3/workflows/update', payload)
  if (r?.taskId) {
    const until = Date.now() + TASK_WAIT_MS
    for (;;) {
      const t = await jira.get(`/rest/api/3/task/${r.taskId}`)
      if (['COMPLETE', 'FAILED', 'CANCELLED', 'DEAD'].includes(t.status)) {
        if (t.status !== 'COMPLETE') return { applied: false, errors: [{ message: `Jira task ${r.taskId} ended ${t.status}${t.message ? `: ${t.message}` : ''}`, transitionId: null }], warnings: v.warnings }
        break
      }
      if (Date.now() > until) return { applied: false, errors: [{ message: `Jira is still updating the workflow (task ${r.taskId}); check the project in a minute`, transitionId: null }], warnings: v.warnings }
      await new Promise((ok) => setTimeout(ok, 1500))
    }
  }
  return { applied: true, errors: [], warnings: v.warnings }
}
