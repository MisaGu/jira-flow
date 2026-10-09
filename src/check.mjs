// A Jira project against a template: each item is ok, warn (to fix), bad (missing) or unknown (cannot tell), with a
// text code and its variables instead of a phrase (rule K4); describe() turns codes into text for a language. The plan
// is the fixes of the check and who can make them: api — this module, manual — only a person in Jira, check — not
// known without a login.
import { enums } from './enums.mjs'
import { textOf } from './lang.mjs'
import { norm } from './template.mjs'

const { state: S, item: I } = enums

export function checkProject(p, tpl) {
  const items = []
  const add = (key, state, code, vars = {}, fix = null) => items.push({ key, state, code, vars, fix })
  if (p.kind === 'service_desk') add(I.KIND, S.BAD, 'check.kind.service_desk')
  else if (p.kind === 'business') add(I.KIND, S.WARN, 'check.kind.business')
  else add(I.KIND, S.OK, 'check.kind.software', { managed: p.managed })

  const have = p.statuses || []
  const missing = []
  const renames = []
  const cats = []
  for (const s of tpl.statuses) {
    const exact = have.find((h) => h.name === s.name)
    const loose = exact || have.find((h) => norm(h.name) === norm(s.name))
    if (!loose) missing.push(s.name)
    else {
      if (!exact) renames.push(`${loose.name} → ${s.name}`)
      if (loose.category !== s.category) cats.push(s.name)
    }
  }
  const extra = have.filter((h) => !tpl.statuses.some((s) => norm(s.name) === norm(h.name))).map((h) => h.name)
  const total = tpl.statuses.length
  if (!p.statuses) add(I.STATUSES, S.UNKNOWN, 'check.statuses.unknown', {}, { code: 'fix.statuses.check' })
  else if (missing.length) add(I.STATUSES, S.BAD, 'check.statuses.missing', { names: missing }, { code: 'fix.statuses.create', vars: { names: missing } })
  else if (renames.length) add(I.STATUSES, S.WARN, 'check.statuses.renamed', { total, pairs: renames }, { code: 'fix.statuses.rename', vars: { pairs: renames } })
  else add(I.STATUSES, S.OK, extra.length ? 'check.statuses.ok_extra' : 'check.statuses.ok', { total, extra })
  if (cats.length) add(I.CATEGORIES, S.WARN, 'check.categories.wrong', { names: cats }, { code: 'fix.categories', vars: { names: cats } })
  else if (p.statuses && !missing.length) add(I.CATEGORIES, S.OK, 'check.categories.ok')

  const all = tpl.transitions.length
  if (!p.transitions) add(I.TRANSITIONS, S.UNKNOWN, 'check.transitions.unknown', { total: all }, { code: 'fix.transitions.check', vars: { total: all } })
  else {
    const key = (t) => `${t.from}→${norm(t.to)}`
    const got = new Set(p.transitions.map(key))
    const lack = tpl.transitions.filter((t) => !got.has(key(t)))
    if (lack.length) add(I.TRANSITIONS, S.BAD, 'check.transitions.missing', { count: lack.length, total: all, sample: lack.slice(0, 4).map((t) => `${t.from} → ${t.to}`) }, { code: 'fix.transitions.add', vars: { count: lack.length } })
    else add(I.TRANSITIONS, S.OK, 'check.transitions.ok', { total: all })
  }
  if (p.initial) {
    const same = norm(p.initial) === norm(tpl.initial)
    add(I.INITIAL, same ? S.OK : S.WARN, same ? 'check.initial.ok' : 'check.initial.other', { have: p.initial, want: tpl.initial }, same ? null : { code: 'fix.initial', vars: { want: tpl.initial } })
  }

  if (!p.board) {
    if (p.kind === 'business') add(I.BOARD, S.WARN, 'check.board.business')
    else add(I.BOARD, S.BAD, 'check.board.none', {}, { code: 'fix.board.create' })
  } else {
    const cols = p.board.columns.map(norm)
    const same = cols.length === tpl.columns.length && tpl.columns.every((c, i) => cols[i] === norm(c))
    const lack = tpl.columns.filter((c) => !cols.includes(norm(c)))
    if (same) add(I.BOARD, S.OK, 'check.board.ok', { name: p.board.name, count: tpl.columns.length })
    else if (lack.length) add(I.BOARD, S.WARN, 'check.board.missing', { name: p.board.name, names: lack }, { code: 'fix.board.columns', vars: { names: lack } })
    else add(I.BOARD, S.WARN, 'check.board.order', { name: p.board.name, now: p.board.columns }, { code: 'fix.board.order' })
  }

  const types = p.types || []
  const lackT = tpl.types.filter((t) => !types.includes(t.name))
  const needT = lackT.filter((t) => t.required).map((t) => t.name)
  if (needT.length) add(I.TYPES, S.BAD, 'check.types.required', { names: needT }, { code: 'fix.types', vars: { names: needT } })
  else if (lackT.length) add(I.TYPES, S.WARN, 'check.types.optional', { names: lackT.map((t) => t.name) })
  else add(I.TYPES, S.OK, 'check.types.ok', { names: tpl.types.map((t) => t.name) })

  // Issues in the project are information while the project follows the template; with something to fix they limit
  // what can go in (applyTemplate: only what moves no issue).
  const open = items.some((i) => i.state === S.BAD || (i.state === S.WARN && i.key !== I.TYPES))
  if (!p.issues) add(I.ISSUES, S.OK, 'check.issues.none', { count: 0 })
  else add(I.ISSUES, open ? S.WARN : S.OK, open ? 'check.issues.limits' : 'check.issues.follow', { count: p.issues })
  return withCounts({ project: p.key, template: { id: tpl.id, version: tpl.version }, items })
}

// The rules item: whether transition rules in Jira already follow the roles (changed — transitions to fix).
export function rulesItem(changed) {
  return changed ? { key: I.RULES, state: S.WARN, code: 'check.rules.differ', vars: { count: changed }, fix: { code: 'fix.rules', vars: {} } } : { key: I.RULES, state: S.OK, code: 'check.rules.ok', vars: {}, fix: null }
}

export function withCounts(check) {
  const count = (s) => check.items.filter((i) => i.state === s).length
  return { ...check, ok: count(S.OK), warn: count(S.WARN), bad: count(S.BAD), unknown: count(S.UNKNOWN) }
}

export function planFor(p, check, { live = false } = {}) {
  const via = (key) => (p.kind === 'service_desk' || (key === I.BOARD && p.managed !== 'team') ? enums.via.MANUAL : live ? enums.via.API : enums.via.CHECK)
  return check.items.filter((i) => i.fix).map((i) => ({ key: i.key, code: i.fix.code, vars: i.fix.vars || {}, via: via(i.key) }))
}

// Codes to text for a person: title, text and fix text of each item, text and via label of each plan step.
export function describe(result, lang = 'en') {
  const items = (result.items || []).map((i) => ({ ...i, title: enums.item.label(i.key, lang), text: textOf(i.code, lang, i.vars), ...(i.fix ? { fix: { ...i.fix, text: textOf(i.fix.code, lang, i.fix.vars) } } : {}) }))
  const plan = (result.plan || []).map((s) => ({ ...s, text: textOf(s.code, lang, s.vars), viaText: enums.via.label(s.via, lang) }))
  return { ...result, items, ...(result.plan ? { plan } : {}) }
}
