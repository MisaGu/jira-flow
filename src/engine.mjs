// The service engine: everything a host does with Jira, behind one object. The host says where the login, the saved
// roles and a space live (src/hosts.mjs, or the caller's own object of the same shape); a space is the host's project
// whose items become issues — its Jira project and epics, the sync switch, the links item ↔ issue. The engine owns the
// Jira client, the template work (check, apply, a new project, roles), the epic check and the sync queue. Every method
// returns plain JSON, the results of contract/calls.schema.json; what the sync does goes to emit('jira', event)
// (contract/events.schema.json). Errors are FlowError with a code, an English message and text — the same for a person
// in lang; said(e) is what to show.
//
// host = {
//   name,
//   account: { get() → { site, email, token, source? } | null, save({ site, email, token }), forget(), view?() → {} },
//   roles:   { get(site, key) → { <role>: { people, assign } }, save(site, key, roles) },
//   space?:  { id,                                       — makes issue labels unique per space
//              link:  { get(site) → { project, epic?, epics? } | null, set(site, { project, epic?, epics? }) },
//              sync:  { get() → { on, since }, set(patch) },
//              links: { get(site, id), put(site, id, patch) → link, all(site) → { <id>: link } },
//              items(id?) → [{ id, summary, body?, status, notes?, group?, firstAt?, at?, view? }],
//              groups?() → [{ id, title }] },                — every group, those without items too
// }
//
// Epics: the issue of an item goes under its own epic, else its group's, else the space's (epic). epics = { groups:
// { <group id>: key | null }, items: { <item id>: key | null } } — an entry is that level's choice, null — no epic,
// the level above is not asked; no entry — the level above decides. A group is the host's way to sort its items (a
// section, a screen); without groups() the groups are the ones the items name.
import { applyTemplate, createFromTemplate, inspect } from './apply.mjs'
import { describe } from './check.mjs'
import { boardUrl, createClient, issueUrl, siteCloudId, SITE_RE } from './client.mjs'
import { enums } from './enums.mjs'
import { fail, FlowError } from './errors.mjs'
import { ISSUE_KEY_RE, listEpics, readIssue } from './issues.mjs'
import { checkLang, labels, textOf } from './lang.mjs'
import { isAdmin, KEY_RE, listProjects, readPeople } from './project.mjs'
import { createSync } from './sync.mjs'
import { describeTemplate, loadTemplate, roleOf, rolesFor, validateTemplate } from './template.mjs'

const PROJECTS_TTL_MS = 30000
const SETTLE_MS = 1500
const START_MS = 3000
const FEED_MAX = 50

// An epic is one level above a task; Jira did not tell the level — by the type's name.
const isEpic = (i) => i.level === 1 || (i.level == null && /^epic$/i.test(i.type || ''))

// client, ops, fetch — for tests: a Jira client instead of the login's, Jira operations instead of the real ones, a
// fetch for the login check and the site's cloudId. settleMs — how long the item changes settle before a sync step;
// startMs — the sync of every item after the start (autostart: false — none).
export function createFlow({ host, emit = () => {}, lang = 'en', template = 'design-dev', prefix = 'flow', client: clientOf = null, ops = {}, fetch: f = null, retryMs = null, settleMs = SETTLE_MS, startMs = START_MS, autostart = true } = {}) {
  if (!host?.account?.get || !host.roles?.get) fail('INPUT', 'host needs account { get, save, forget } and roles { get, save }')
  lang = checkLang(lang)
  const tpl = typeof template === 'string' ? loadTemplate(template) : validateTemplate(template)
  const viaFetch = f ? { fetch: f } : {}
  const op = { inspect, applyTemplate, createFromTemplate, listProjects, isAdmin, readPeople, readIssue, listEpics, cloudId: (site) => siteCloudId(site, viaFetch), ...ops }
  const text = (key, vars) => textOf(key, lang, vars)
  // An error a person reads: the code, an English message, the text in lang.
  const err = (code, key, vars = {}) => new FlowError(code, textOf(key, 'en', vars), { text: text(key, vars) })
  const said = (e) => e?.text || (e?.code && enums.code.values.includes(e.code) ? `${enums.code.label(e.code, lang)}: ${e.message}` : e?.message || String(e))

  // ── the login and the Jira client: one client per login ─────────────────────────────────────────────────────────
  const login = () => host.account.get() || null
  const site = () => login()?.site || null
  let made = { id: null, client: null }
  function client() {
    if (clientOf) return clientOf()
    const l = login()
    if (!l?.token) return null
    const id = JSON.stringify([l.site, l.email, l.token])
    if (made.id !== id) made = { id, client: createClient({ site: l.site, email: l.email, token: l.token, ...viaFetch }) }
    return made.client
  }
  function need() {
    const jira = client()
    if (!jira) throw err('NO_LOGIN', 'error.no_login')
    return jira
  }
  function keyOf(k) {
    const key = String(k ?? '').trim().toUpperCase()
    if (!KEY_RE.test(key)) throw err('INPUT', 'error.project_key', { key: String(k ?? '') })
    return key
  }

  function account() {
    const l = login()
    return { site: l?.site || null, email: l?.email || null, token: Boolean(l?.token), source: l?.source || null, ...(host.account.view?.() || {}) }
  }

  // Projects of the site: half a minute of cache, its own for every site.
  let proj = { site: null, at: 0, list: null }
  const forgetProjects = () => (proj = { site: null, at: 0, list: null })
  async function projects(fresh = false) {
    const jira = client()
    if (proj.site !== site()) proj = { site: site(), at: 0, list: null }
    if (jira && (fresh || !proj.list || Date.now() - proj.at > PROJECTS_TTL_MS)) {
      try {
        proj = { site: site(), at: Date.now(), list: await op.listProjects(jira) }
      } catch {
        // Jira did not answer: the list stays as it was
      }
    }
    return proj.list || []
  }

  // The template in lang: titles and texts of statuses, roles, types and rules, category labels, board columns.
  function meta() {
    const d = describeTemplate(tpl, lang)
    return { ...d, categories: labels(lang).enum.category, columns: tpl.columns }
  }

  async function overview() {
    const list = await projects()
    const s = site()
    const jira = client()
    let cloudId = null
    let canCreate = false
    if (jira) {
      try {
        cloudId = await op.cloudId(s)
      } catch {
        // the site did not tell its cloudId
      }
      try {
        canCreate = await op.isAdmin(jira)
      } catch {
        canCreate = false
      }
    }
    return { host: host.name || null, site: s, cloudId, connected: Boolean(proj.list), account: account(), canCreate, projects: list.map((p) => ({ ...p, url: boardUrl(s, p.key) })), template: meta(), lang }
  }

  // The login is checked against Jira before it is saved: a wrong token is not written.
  async function signIn({ site: raw, email, token } = {}) {
    const s = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    const e = String(email || '').trim()
    const t = String(token || '').trim()
    if (!SITE_RE.test(s)) throw err('INPUT', 'error.site')
    if (!e || !t) throw err('NO_LOGIN', 'error.login')
    await createClient({ site: s, email: e, token: t, ...viaFetch }).get('/rest/api/3/myself')
    host.account.save({ site: s, email: e, token: t })
    forgetProjects()
    return overview()
  }
  async function signOut() {
    host.account.forget()
    forgetProjects()
    return overview()
  }

  // ── the template: check, apply, a new project, roles ────────────────────────────────────────────────────────────
  const savedRoles = (key) => host.roles.get(site(), key) || {}
  function rolesView(people, roles) {
    const m = meta()
    const name = (id) => people.users.find((u) => u.accountId === id)?.name || id
    return {
      me: people.me,
      users: people.users,
      admin: people.admin,
      single: people.users.length <= 1,
      roles: m.roles.map((r) => {
        const role = roles[r.key]
        return { ...r, people: role.people.map((id) => ({ accountId: id, name: name(id) })), assign: role.assign, assignName: role.assign ? name(role.assign) : '' }
      }),
    }
  }
  function checkView(r) {
    const d = describe(r, lang)
    return {
      ...d,
      items: d.items.map((i) => ({ key: i.key, state: i.state, title: i.title, detail: i.text, fix: i.fix ? { what: i.fix.text } : null })),
      plan: d.plan.map((s) => ({ key: s.key, what: s.text, via: s.via })),
    }
  }
  function summaryView(s, cols) {
    const cat = (c) => enums.category.label(c, lang)
    return {
      ...s,
      changed: s.changed.map((c) => `${c.from}${c.from !== c.to ? ` → ${c.to}` : ''}${c.category ? text('apply.category', { category: cat(c.category) }) : ''}`),
      columns: tpl.columns,
      ...(cols !== undefined ? { columnsPlan: cols && { ...cols, error: cols.error ? said(cols.error) : null } } : {}),
    }
  }
  const messages = (list = []) => list.map((e) => (e.transitionId ? text('apply.transition', { message: e.message, id: e.transitionId }) : e.message))
  function applyView(r, key) {
    return {
      ...r,
      summary: r.summary && summaryView(r.summary),
      errors: messages(r.errors),
      warnings: messages(r.warnings),
      columns: r.columns && { ...r.columns, error: r.columns.error ? said(r.columns.error) : null },
      check: r.check ? checkView(r.check) : null,
      roles: r.people ? rolesView(r.people, r.roles) : null,
      people: undefined,
      url: boardUrl(site(), key, r.board?.id),
    }
  }

  // The project as Jira has it now: items, the plan, what applying would do, the columns, the roles.
  async function check({ project } = {}) {
    const key = keyOf(project)
    const r = await op.inspect(need(), key, { template: tpl, roles: savedRoles(key) })
    const p = r.project
    return {
      ...checkView(r),
      source: 'live',
      at: new Date().toISOString(),
      apply: r.apply && { ...summaryView(r.apply, r.apply.columns), roles: rolesView(r.people, r.roles), blocked: r.apply.blocked ? textOf(`blocked.${r.apply.blocked.code}`, lang, r.apply.blocked.vars) : null },
      project: { key: p.key, name: p.name, issues: p.issues, workflows: p.workflows, initial: p.initial, board: p.board, url: boardUrl(site(), p.key, p.board?.id) },
    }
  }
  async function apply({ project, dryRun = false } = {}) {
    const key = keyOf(project)
    return applyView(await op.applyTemplate(need(), key, { template: tpl, roles: savedRoles(key), dryRun: Boolean(dryRun), lang }), key)
  }
  async function create({ key: raw, name } = {}) {
    const key = keyOf(raw)
    const r = await op.createFromTemplate(need(), { key, name: String(name || '').trim() || key, template: tpl, roles: {}, lang })
    forgetProjects()
    return { created: r.created, name: r.name, ...applyView(r, key) }
  }
  async function roles({ project } = {}) {
    const key = keyOf(project)
    const people = await op.readPeople(need(), key)
    return rolesView(people, rolesFor(people, savedRoles(key), tpl))
  }
  // A role: people (at least one, only people of the project) and whom to assign — one of them or null (nobody).
  async function saveRoles({ project, roles: pick = {} } = {}) {
    const key = keyOf(project)
    const ids = new Set((await op.readPeople(need(), key)).users.map((u) => u.accountId))
    const out = {}
    for (const r of meta().roles) {
      const s = roleOf(pick?.[r.key])
      if (!s) continue
      const people = s.people.filter((id) => ids.has(id))
      if (!people.length) throw err('INPUT', 'error.role_empty', { role: r.title })
      out[r.key] = { people, assign: s.assign === null ? null : people.includes(s.assign) ? s.assign : people[0] }
    }
    host.roles.save(site(), key, { ...savedRoles(key), ...out })
    return roles({ project: key })
  }

  // ── a space: its Jira project and epics, the sync of its items ─────────────────────────────────────────────────
  const sp = host.space || null
  function spaceOnly() {
    if (!sp) throw err('INPUT', 'error.no_space')
  }
  const epicOf = (l) => (ISSUE_KEY_RE.test(l?.epic || '') ? l.epic : null)
  // A level's choices: a key or null (no epic); anything else is dropped.
  const choices = (m) => Object.fromEntries(Object.entries(m && typeof m === 'object' ? m : {}).filter(([, v]) => v === null || ISSUE_KEY_RE.test(String(v))))
  function link() {
    const s = site()
    const l = s && sp ? sp.link.get(s) : null
    return l?.project ? { site: s, project: l.project, epic: epicOf(l), epics: { groups: choices(l.epics?.groups), items: choices(l.epics?.items) } } : null
  }
  // The link as the host keeps it: the epics only when some level has a choice.
  function putLink(l, { epic = l.epic, epics = l.epics } = {}) {
    const some = Object.keys(epics.groups).length + Object.keys(epics.items).length > 0
    sp.link.set(l.site, { project: l.project, ...(epic ? { epic } : {}), ...(some ? { epics } : {}) })
  }
  const choiceOf = (m, k) => (k != null && Object.hasOwn(m, String(k)) ? m[String(k)] : undefined)
  // The epic of an item and whose choice it is: item, group, space; none — key null.
  function epicFor(item, l = link()) {
    if (!l) return { key: null, from: null }
    for (const [from, v] of [['item', choiceOf(l.epics.items, item.id)], ['group', choiceOf(l.epics.groups, item.group)]]) if (v !== undefined) return { key: v, from }
    return { key: l.epic, from: l.epic ? 'space' : null }
  }
  // The groups of the space with how many items each has: the host's list, or the groups its items name.
  function groupsOf() {
    const n = new Map()
    for (const i of sp.items()) if (i.group != null && i.group !== '') n.set(String(i.group), (n.get(String(i.group)) || 0) + 1)
    const list = sp.groups ? sp.groups() : [...n.keys()].map((id) => ({ id, title: id }))
    return list.map((g) => ({ id: String(g.id), title: String(g.title ?? g.id), items: n.get(String(g.id)) || 0 }))
  }
  function syncNow() {
    const v = sp?.sync.get() || {}
    return { on: Boolean(v.on), since: v.since || null }
  }
  function state() {
    const l = link()
    return { ...syncNow(), site: site(), project: l?.project || null, epic: l?.epic || null }
  }
  const store = { get: (id) => sp.links.get(site(), id) || null, put: (id, patch) => sp.links.put(site(), id, patch) }

  // The Jira project of the space; the epics belong to it: the same project keeps them, another drops them.
  function setLink({ project } = {}) {
    spaceOnly()
    const s = site()
    if (!s) throw err('NO_LOGIN', 'error.no_login')
    const key = keyOf(project)
    const was = link()
    putLink({ site: s, project: key }, was?.project === key ? was : { epic: null, epics: { groups: {}, items: {} } })
    return state()
  }

  // An epic for the items: in Jira, of the space's Jira project, one level above a task.
  async function readEpic(key, project) {
    const jira = need()
    let i
    try {
      i = await op.readIssue(jira, key)
    } catch (e) {
      if (e.code === 'NOT_FOUND') throw err('NOT_FOUND', 'error.epic_missing', { key })
      throw e
    }
    if (i.project !== project) throw err('INPUT', 'error.epic_project', { key: i.key, other: i.project, project })
    if (!isEpic(i)) throw err('INPUT', 'error.epic_type', { key: i.key, type: i.type })
    return { key: i.key, summary: i.summary, status: i.status, url: issueUrl(site(), i.key) }
  }
  // The space's epic as Jira has it now: there and still an epic — ok; otherwise the reason.
  async function epic() {
    spaceOnly()
    const l = link()
    if (!l?.epic) return { key: null }
    try {
      return { ...(await readEpic(l.epic, l.project)), ok: true }
    } catch (e) {
      return { key: l.epic, url: issueUrl(l.site, l.epic), ok: false, problem: said(e) }
    }
  }
  // Every level at once: the Jira project's epics to pick from, the space's epic, each group with its choice and the
  // epic its items get, the items' own choices; a chosen key that is no longer an epic of the project — with why.
  async function epics() {
    spaceOnly()
    const l = link()
    if (!l?.project) throw err('INPUT', 'error.no_project')
    const list = (await op.listEpics(need(), l.project)).map((e) => ({ key: e.key, summary: e.summary, status: e.status, url: issueUrl(l.site, e.key) }))
    const groups = groupsOf().map((g) => {
      const own = choiceOf(l.epics.groups, g.id)
      return { ...g, epic: own === undefined ? l.epic : own, ...(own !== undefined ? { own } : {}) }
    })
    const known = new Set(list.map((e) => e.key))
    const chosen = new Set([l.epic, ...Object.values(l.epics.groups), ...Object.values(l.epics.items)].filter(Boolean))
    const missing = [...chosen].filter((k) => !known.has(k)).map((key) => ({ key, problem: text('error.epic_gone', { key, project: l.project }) }))
    return { project: l.project, epic: l.epic, list, groups, items: l.epics.items, missing }
  }
  // Set an epic (checked in Jira) or drop it (empty): the space's; a group's (group); an item's own (id). A group or
  // an item set to empty gets no epic at all; inherit — its choice goes, the level above decides. With the sync on,
  // the issues it touches go under the new epic at once; an issue left without an epic stays where it is.
  async function setEpic({ epic: raw, group = null, id = null, inherit = false } = {}) {
    spaceOnly()
    const l = link()
    if (!l?.project) throw err('INPUT', 'error.no_project')
    if (group != null && id != null) throw err('INPUT', 'error.epic_target')
    const level = id != null ? 'items' : group != null ? 'groups' : null
    const at = level ? String(level === 'items' ? id : group) : null
    if (level === 'items' && !sp.items(at).length) throw err('INPUT', 'error.no_item', { id: at })
    if (level === 'groups' && !groupsOf().some((g) => g.id === at)) throw err('INPUT', 'error.no_group', { id: at })
    const key = inherit ? '' : String(raw ?? '').trim().toUpperCase()
    if (key && !ISSUE_KEY_RE.test(key)) throw err('INPUT', 'error.epic_key', { project: l.project, raw: String(raw).trim() })
    const info = key ? await readEpic(key, l.project) : null
    if (!level) putLink(l, { epic: info?.key || null })
    else {
      const m = { ...l.epics[level] }
      if (inherit) delete m[at]
      else m[at] = info?.key || null
      putLink(l, { epics: { ...l.epics, [level]: m } })
    }
    if (syncNow().on) reconcileAll(level === 'items' ? (i) => i.id === at : level === 'groups' ? (i) => String(i.group ?? '') === at : null)
    return { ...state(), epicInfo: info ? { ...info, ok: true } : { key: null } }
  }

  const engine = sp ? createSync({ client, project: () => link()?.project, template: tpl, store, scope: sp.id || '', prefix, onEvent: (e) => emit('jira', e), ...(retryMs ? { retryMs } : {}) }) : null
  const timers = new Map()
  let closed = false
  function schedule(id, ms = settleMs) {
    if (closed) return
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        reconcile(id)
      }, ms),
    )
  }
  // An item as it is now → the sync engine. An item from before the sync was switched on is not written until added.
  function reconcile(id) {
    const st = state()
    if (!st.on || !st.project || closed) return
    const item = sp.items(id)[0]
    if (!item) return
    const l = store.get(id)
    if (l?.skip) return
    if (!l && st.since && item.firstAt && item.firstAt < st.since) {
      store.put(id, { skip: true })
      return
    }
    try {
      engine.push({ id, summary: item.summary, body: item.body || '', status: item.status, notes: Array.isArray(item.notes) ? item.notes : [], parent: epicFor(item).key })
    } catch (e) {
      store.put(id, { error: { code: e.code || 'INPUT', message: e.message } })
      emit('jira', { type: enums.event.ERROR, id, code: e.code || 'INPUT', message: e.message, retry: false })
    }
  }
  // Every item, or those pick takes.
  function reconcileAll(pick = null) {
    for (const i of sp.items()) if (!pick || pick(i)) schedule(i.id, 0)
  }
  const startTimer = sp && autostart && syncNow().on ? setTimeout(() => reconcileAll(), startMs) : null

  const linkView = (l) =>
    l ? { key: l.key || null, url: l.key ? issueUrl(site(), l.key) : null, applied: l.applied || null, parent: l.parent || null, error: !l.error ? null : typeof l.error === 'string' ? l.error : said(l.error), skip: Boolean(l.skip), pending: Boolean(l.pending) } : null
  // The items with their issues on this site; view — what the host shows of an item, as it gave it; epic — the one
  // its issue goes under and whose choice it is.
  function feed({ max = FEED_MAX } = {}) {
    spaceOnly()
    const s = site()
    const links = s ? sp.links.all(s) || {} : {}
    const l = link()
    const all = sp.items().map((i) => ({ id: i.id, summary: i.summary, status: i.status, at: i.at || null, ...(i.view || {}), group: i.group ?? null, epic: epicFor(i, l), jira: linkView(links[i.id]) }))
    const by = (name) => all.filter((i) => i.status === name).length
    return { total: all.length, items: all.slice(0, max), byStatus: Object.fromEntries(tpl.statuses.map((x) => [x.name, by(x.name)])), sync: state(), linked: all.filter((i) => i.jira?.key).length }
  }
  function syncView() {
    spaceOnly()
    const s = site()
    const all = Object.values(s ? sp.links.all(s) || {} : {})
    return { ...state(), linked: all.filter((l) => l.key).length, skipped: all.filter((l) => l.skip).length, errors: all.filter((l) => l.error).length }
  }
  // Switch the sync on: ids — items that exist now and go to Jira at once; the other existing ones do not. New items
  // go by themselves from now on.
  function setSync({ on, ids = [] } = {}) {
    spaceOnly()
    if (!on) {
      sp.sync.set({ on: false })
      return syncView()
    }
    if (!link()?.project) throw err('INPUT', 'error.no_project')
    if (!client()) throw err('NO_LOGIN', 'error.no_login')
    const pick = new Set((Array.isArray(ids) ? ids : []).map(String))
    for (const i of sp.items()) {
      if (store.get(i.id)?.key) continue
      store.put(i.id, pick.has(i.id) ? { skip: false, pending: true } : { skip: true })
    }
    if (!syncNow().on) sp.sync.set({ on: true, since: new Date().toISOString() })
    for (const id of pick) schedule(id, 0)
    return syncView()
  }
  function add({ id } = {}) {
    spaceOnly()
    const key = String(id ?? '')
    if (!sp.items(key).length) throw err('INPUT', 'error.no_item', { id: key })
    store.put(key, { skip: false, pending: true, error: null })
    schedule(key, 0)
    return syncView()
  }
  // The host says which items changed; they go to Jira once their changes settle.
  function changed(ids) {
    if (!sp || closed || !syncNow().on) return
    for (const id of [].concat(ids)) if (id) schedule(String(id))
  }
  // The host has a new summary and body for an item (a full description written later): the same issue gets them.
  async function rewrite(id, { summary, body } = {}) {
    if (!sp || !syncNow().on) return false
    return engine.rewrite(String(id), { summary, body })
  }

  return {
    lang,
    said,
    meta,
    account,
    overview,
    projects,
    login: signIn,
    logout: signOut,
    labels: () => labels(lang),
    check,
    apply,
    create,
    roles,
    saveRoles,
    state,
    setLink,
    epic,
    epics,
    setEpic,
    sync: syncView,
    setSync,
    add,
    feed,
    changed,
    rewrite,
    // For tests and shutdown: run what is waiting now and wait for the queue (a created issue may ask for one more step).
    async idle() {
      for (let round = 0; round < 2; round++) {
        for (const [id, t] of timers) {
          clearTimeout(t)
          timers.delete(id)
          reconcile(id)
        }
        await engine?.idle()
      }
    },
    close() {
      closed = true
      clearTimeout(startTimer)
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
      engine?.close()
    },
  }
}
