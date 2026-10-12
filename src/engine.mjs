// The service engine: everything a host does with Jira, behind one object. The host says where the login, the saved
// roles and a space live (src/hosts.mjs, or the caller's own object of the same shape); a space is the host's project
// whose items become issues — its Jira project and epic, the sync switch, the links item ↔ issue. The engine owns the
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
//              link:  { get(site) → { project, epic? } | null, set(site, { project, epic? }) },
//              sync:  { get() → { on, since }, set(patch) },
//              links: { get(site, id), put(site, id, patch) → link, all(site) → { <id>: link } },
//              items(id?) → [{ id, summary, body?, status, notes?, firstAt?, at?, view? }] },
// }
import { applyTemplate, createFromTemplate, inspect } from './apply.mjs'
import { describe } from './check.mjs'
import { boardUrl, createClient, issueUrl, siteCloudId, SITE_RE } from './client.mjs'
import { enums } from './enums.mjs'
import { fail, FlowError } from './errors.mjs'
import { ISSUE_KEY_RE, readIssue } from './issues.mjs'
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
  const op = { inspect, applyTemplate, createFromTemplate, listProjects, isAdmin, readPeople, readIssue, cloudId: (site) => siteCloudId(site, viaFetch), ...ops }
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

  // ── a space: its Jira project and epic, the sync of its items ──────────────────────────────────────────────────
  const sp = host.space || null
  function spaceOnly() {
    if (!sp) throw err('INPUT', 'error.no_space')
  }
  const epicOf = (l) => (ISSUE_KEY_RE.test(l?.epic || '') ? l.epic : null)
  function link() {
    const s = site()
    const l = s && sp ? sp.link.get(s) : null
    return l?.project ? { site: s, project: l.project, epic: epicOf(l) } : null
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

  // The Jira project of the space; the epic belongs to it: the same project keeps the epic, another drops it.
  function setLink({ project } = {}) {
    spaceOnly()
    const s = site()
    if (!s) throw err('NO_LOGIN', 'error.no_login')
    const key = keyOf(project)
    const was = link()
    const epic = was?.project === key ? was.epic : null
    sp.link.set(s, { project: key, ...(epic ? { epic } : {}) })
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
  // The epic as Jira has it now: there and still an epic — ok; otherwise the reason.
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
  // Set the epic (checked in Jira) or drop it (empty). With the sync on, the issues already in Jira go under the new
  // epic at once; dropped — new issues go without an epic, earlier ones stay under it.
  async function setEpic({ epic: raw } = {}) {
    spaceOnly()
    const l = link()
    if (!l?.project) throw err('INPUT', 'error.no_project')
    const key = String(raw ?? '').trim().toUpperCase()
    if (!key) {
      sp.link.set(l.site, { project: l.project })
      return { ...state(), epicInfo: { key: null } }
    }
    if (!ISSUE_KEY_RE.test(key)) throw err('INPUT', 'error.epic_key', { project: l.project, raw: String(raw).trim() })
    const info = await readEpic(key, l.project)
    sp.link.set(l.site, { project: l.project, epic: info.key })
    if (syncNow().on) reconcileAll()
    return { ...state(), epicInfo: { ...info, ok: true } }
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
      engine.push({ id, summary: item.summary, body: item.body || '', status: item.status, notes: Array.isArray(item.notes) ? item.notes : [], parent: st.epic })
    } catch (e) {
      store.put(id, { error: { code: e.code || 'INPUT', message: e.message } })
      emit('jira', { type: enums.event.ERROR, id, code: e.code || 'INPUT', message: e.message, retry: false })
    }
  }
  function reconcileAll() {
    for (const i of sp.items()) schedule(i.id, 0)
  }
  const startTimer = sp && autostart && syncNow().on ? setTimeout(reconcileAll, startMs) : null

  const linkView = (l) =>
    l ? { key: l.key || null, url: l.key ? issueUrl(site(), l.key) : null, applied: l.applied || null, parent: l.parent || null, error: !l.error ? null : typeof l.error === 'string' ? l.error : said(l.error), skip: Boolean(l.skip), pending: Boolean(l.pending) } : null
  // The items with their issues on this site; view — what the host shows of an item, as it gave it.
  function feed({ max = FEED_MAX } = {}) {
    spaceOnly()
    const s = site()
    const links = s ? sp.links.all(s) || {} : {}
    const all = sp.items().map((i) => ({ id: i.id, summary: i.summary, status: i.status, at: i.at || null, ...(i.view || {}), jira: linkView(links[i.id]) }))
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
