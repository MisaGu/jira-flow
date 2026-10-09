// Workflow template: statuses with categories, transitions (from "*" — from any status), the status a new issue
// starts in, board columns, issue types and roles. A template is data (templates/<id>.json or the host's own object);
// texts about it for people live in locales under template.<id>.*. Roles say who leads an issue in which statuses
// and who may move it into a gate status; rulesFor turns them into Jira transition rules.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { enums } from './enums.mjs'
import { fail } from './errors.mjs'
import { textOf } from './lang.mjs'

const DIR = fileURLToPath(new URL('../templates/', import.meta.url))
export const TEMPLATE_IDS = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
export const norm = (s) => String(s || '').trim().toLowerCase()

export function validateTemplate(t) {
  const bad = (why) => fail('INPUT', `template ${t?.id || '?'}: ${why}`)
  if (!t || typeof t !== 'object' || !/^[a-z][a-z0-9-]{1,40}$/.test(t.id || '')) bad('id must be kebab-case')
  if (!Number.isInteger(t.version) || t.version < 1) bad('version must be a positive integer')
  const names = (t.statuses || []).map((s) => s.name)
  if (!names.length || new Set(names.map(norm)).size !== names.length) bad('statuses must be non-empty with unique names')
  for (const s of t.statuses) {
    if (!enums.category.values.includes(s.category)) bad(`status ${s.name}: category ${s.category}`)
    if (s.phase !== null && s.phase !== undefined && !enums.phase.values.includes(s.phase)) bad(`status ${s.name}: phase ${s.phase}`)
  }
  const known = (n) => names.includes(n)
  if (!known(t.initial)) bad(`initial ${t.initial} is not a status`)
  for (const x of t.transitions || []) if ((x.from !== '*' && !known(x.from)) || !known(x.to)) bad(`transition ${x.from} → ${x.to}`)
  for (const c of t.columns || []) if (!known(c)) bad(`column ${c} is not a status`)
  for (const r of t.roles || []) {
    if (!enums.role.values.includes(r.key)) bad(`role ${r.key}`)
    for (const s of [...r.statuses, ...r.gate]) if (!known(s)) bad(`role ${r.key}: ${s} is not a status`)
  }
  if (!(t.types || []).some((x) => x.required)) bad('at least one required issue type')
  return t
}

const cache = new Map()
export function loadTemplate(id = 'design-dev') {
  if (!TEMPLATE_IDS.includes(id)) fail('INPUT', `no template ${id}; known: ${TEMPLATE_IDS.join(', ')}`)
  if (!cache.has(id)) cache.set(id, Object.freeze(validateTemplate(JSON.parse(fs.readFileSync(`${DIR}${id}.json`, 'utf8')))))
  return cache.get(id)
}

// A saved role: { people: [accountId…], assign: accountId | null } — null: nobody, anyone of the role takes the issue.
// A bare accountId string is a role of one person.
export function roleOf(saved) {
  if (typeof saved === 'string') return { people: [saved], assign: saved }
  if (!saved || !Array.isArray(saved.people)) return null
  return { people: [...new Set(saved.people.map(String))], assign: saved.assign === null ? null : String(saved.assign || '') }
}

// Who is on each role: saved people still in the project; nobody left — the login the module works as (with one
// person in Jira, that is everybody). The assignee is one of the role, otherwise its first person.
export function rolesFor(people, saved = {}, tpl) {
  const ids = new Set(people.users.map((u) => u.accountId))
  return Object.fromEntries(
    tpl.roles.map((r) => {
      const s = roleOf(saved?.[r.key])
      const list = (s?.people || []).filter((id) => ids.has(id))
      const ppl = list.length ? list : [people.me.accountId]
      const assign = s?.assign === null && list.length ? null : ppl.includes(s?.assign) ? s.assign : ppl[0]
      return [r.key, { people: ppl, assign }]
    }),
  )
}

// Transition rules: entering a status of a role assigns its assignee (or clears the assignee); a gate status lets in
// only the people of its role and the service login (otherwise the service could not move its own issues).
export function rulesFor(roles, tpl, serviceId) {
  const assign = {}
  const restrict = {}
  for (const r of tpl.roles) {
    const role = roles[r.key]
    if (!role) continue
    for (const st of r.statuses) assign[st] = role.assign ? { type: 'to-selected-user', accountId: role.assign } : { type: 'to-unassigned' }
    for (const st of r.gate) restrict[st] = [...new Set([...role.people, serviceId].filter(Boolean))]
  }
  return { assign, restrict }
}

// The template with texts for a person in one language: title, about, statuses, roles, types, rules.
export function describeTemplate(tpl, lang = 'en') {
  const t = (k) => textOf(`template.${tpl.id}.${k}`, lang)
  return {
    ...tpl,
    title: t('title'),
    about: t('about'),
    statuses: tpl.statuses.map((s) => ({ ...s, about: t(`status.${s.name}`), categoryText: enums.category.label(s.category, lang), phaseText: s.phase ? enums.phase.label(s.phase, lang) : '' })),
    roles: tpl.roles.map((r) => ({ ...r, title: enums.role.label(r.key, lang), about: t(`role.${r.key}`) })),
    types: tpl.types.map((x) => ({ ...x, about: t(`type.${x.name}`) })),
    rules: [t('rule.done')],
  }
}
