// jira-flow page: the wizard as a whole page. Steps — Connection (the site and the login), Template (the flow, its
// transitions, board columns and roles), Project (choose or create a Jira project, check it against Jira as it is,
// apply the template), Roles (who leads an issue and who may move it into a gate), Sync (an epic for the issues, the
// sync switch, the items of the space and their issues). Data — the service API (contract/calls.schema.json); every
// text a person reads — the labels of the service (page.* keys, enum labels); helpers — web/shell.js.
import { $, api, clock, en, esc, has, IC, loadLabels, onEvent, plural, render, SPIN, stamp, t, th, toast } from './shell.js'

const STEPS = ['connection', 'template', 'project', 'roles', 'sync']
const [CONN, TPL, PROJ, ROLES, SYNC] = [1, 2, 3, 4, 5]
const FEED_EVERY_MS = 15000
const FEED_SETTLE_MS = 300

// v — the overview (the login, the site, its projects, the template); link — the space: its Jira project and epic and
// the sync switch ({ on, since, site, project, epic }); feed — the items with their issues; check, roles — by Jira
// project key; epic — the epic as Jira has it ({ key, summary, status, url, ok, problem }; null — not read yet).
const S = { v: null, link: null, feed: null, check: {}, roles: {}, epic: null }
const newMk = () => ({ open: false, key: '', name: '', busy: false, error: '' })
const newEpic = () => ({ key: '', busy: false, error: '' })
// The wizard: step; project — the chosen Jira project; error — the last read of Jira that failed; apply — the template
// on the Project step ({ stage: dry | running | checked | confirm | done | error, result, error }); mk — the form of a
// new project; auto — the step follows the first one that needs an action until the person moves on; pick — items
// that exist already and go to Jira at once when the sync goes on; login, epic — their forms.
const W = { step: CONN, project: null, error: '', apply: null, mk: newMk(), rolesSaved: false, auto: false, pick: new Set(), syncBusy: false, syncError: '', rechecking: false, login: { site: '', email: '', token: '', busy: false, error: '' }, epic: newEpic() }
// The rules of the roles into Jira with one button on the Roles step: going, how it ended.
const R = { busy: false, result: null, error: '' }

// ── small parts ────────────────────────────────────────────────────────────────────────────────────────────────
const target = () => (S.link?.project ? S.v?.projects.find((p) => p.key === S.link.project) || { key: S.link.project, name: S.link.project, url: '' } : null)
const checkOf = (key) => S.check[key] || {}
// The project follows the template: nothing missing and nothing to fix; issues in the project and optional types are
// information, not a difference.
const fits = (c) => (c.items ? !c.items.some((i) => i.state === 'bad' || (i.state === 'warn' && i.key !== 'issues' && i.key !== 'types')) : !c.bad && !c.warn)
const syncOn = () => Boolean(S.feed?.sync?.on)
// A status in the color of its Jira category: grey — to do, blue — in progress, green — done.
const CAT = { new: 'jn', indeterminate: 'ji', done: 'jd' }
const pill = (name) => `<span class="jst ${CAT[S.v?.template.statuses.find((s) => s.name === name)?.category] || 'jn'}">${esc(name)}</span>`
const hint = (cls, icon, html, tail = '') => `<div class="hintb ${cls}">${icon}<span>${html}</span>${tail}</div>`
const sum = (c) =>
  ['ok', 'warn', 'bad', 'unknown']
    .filter((k) => c[k])
    .map((k) => `<span class="jck ${k}">${esc(t('page.sum', { count: c[k], state: en('state', k) }))}</span>`)
    .join('')
const MARK = { ok: IC.ok, warn: IC.err, bad: IC.err, unknown: IC.q }
const VIA = { api: 'ok', check: 'sky', manual: 'warn' }
// A text of the service that ends a sentence of the page: without its own final period.
const bare = (s) => String(s || '').replace(/[.\s]+$/, '')
// The board of a project: from the check (with the board id) or from the list of the site.
const boardOf = (key) => ({ key, url: S.check[key]?.project?.url || S.v.projects.find((p) => p.key === key)?.url || '' })

// ── step 1: connection ─────────────────────────────────────────────────────────────────────────────────────────
function stepConnection() {
  const v = S.v
  const a = v.account
  const lg = W.login
  const c = S.check[W.project]
  const state = !a.token
    ? hint('warn', IC.err, th('page.conn.none'))
    : !W.project
      ? v.connected
        ? hint('ok', IC.ok, th('page.conn.works'))
        : hint('bad', IC.err, th('page.conn.no_answer', { site: v.site }))
      : !c
        ? W.error
          ? hint('bad', IC.err, th('page.conn.read_failed', { error: W.error }))
          : hint('sky', SPIN, th('page.conn.checking'))
        : hint('ok', IC.ok, th('page.conn.read', { project: W.project }))
  const source = !a.source ? '' : has(`page.conn.source.${a.source}`) ? t(`page.conn.source.${a.source}`) : a.source
  const rows = [
    [t('page.conn.site'), v.site],
    [t('page.conn.cloud'), v.cloudId],
    [t('page.conn.account'), a.email],
    [t('page.conn.source'), source],
  ]
  const off = lg.busy || !lg.site || !lg.email || !lg.token
  const form = `<div class="jlogin">
      <div class="au-row2"><label class="fldc"><span class="lbl">${esc(t('page.login.site'))}</span><input class="inp mono" data-flow="lgsite" value="${esc(lg.site)}" placeholder="${esc(t('page.login.site_ph'))}" spellcheck="false" autocomplete="off"></label><label class="fldc"><span class="lbl">${esc(t('page.login.email'))}</span><input class="inp" data-flow="lgemail" value="${esc(lg.email)}" placeholder="${esc(t('page.login.email_ph'))}" spellcheck="false" autocomplete="off"></label></div>
      <div class="fldc"><span class="lbl"><label for="flow-token">${esc(t('page.login.token'))}</label><a class="lnk" href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer">${esc(t('page.login.token_where'))}</a></span><input id="flow-token" class="inp mono" type="password" data-flow="lgtoken" value="${esc(lg.token)}" placeholder="${esc(t(a.token ? 'page.login.token_new' : 'page.login.token_ph'))}" spellcheck="false" autocomplete="off"></div>
      ${lg.error ? hint('bad', IC.err, esc(lg.error)) : ''}
      <div class="row"><button type="button" class="btnp" data-flow="lgsave" data-enter ${off ? 'disabled' : ''}>${lg.busy ? SPIN : IC.ok}${esc(t('page.login.save'))}</button>${a.token ? `<button type="button" class="btn" data-flow="lgforget" ${lg.busy ? 'disabled' : ''}>${esc(t('page.login.forget'))}</button>` : ''}</div>
    </div>`
  return `<div><h2>${esc(t('page.conn.title'))}</h2><p>${esc(t('page.conn.about'))}</p></div>
    ${a.token ? `<dl class="kv kv-code">${rows.map(([k, val]) => `<dt>${esc(k)}</dt><dd class="mono">${esc(val || '—')}</dd>`).join('')}</dl>` : ''}
    ${state}
    ${form}
    ${hint('mute', IC.lock, th('page.login.note'))}`
}

// ── step 2: the template ───────────────────────────────────────────────────────────────────────────────────────
// Short names of the statuses for the head of the transition table: initials of the words; two alike — the first
// letter and the next consonant of the first word.
function initials(names) {
  const words = (n) => n.match(/[\p{L}\p{N}]+/gu) || [n]
  const base = names.map((n) => words(n).map((w) => w[0]).join('').toUpperCase())
  return names.map((n, i) => {
    if (base.indexOf(base[i]) === base.lastIndexOf(base[i])) return base[i]
    const more = words(n)[0].slice(1).replace(/[aeiouy]/gi, '')[0] || words(n)[0][1] || ''
    return (base[i] + more).toUpperCase()
  })
}
// Transitions as a table "from × to": ● — a transition; a grey one — global, from any status.
function matrix(tp) {
  const names = tp.statuses.map((s) => s.name)
  const short = initials(names)
  const find = (from, to) => tp.transitions.find((x) => x.from === from && x.to === to) || tp.transitions.find((x) => x.from === '*' && x.to === to)
  const head = `<tr><th></th>${names.map((n, i) => `<th scope="col" data-tip="${esc(n)}" aria-label="${esc(n)}">${esc(short[i])}</th>`).join('')}</tr>`
  const rows = names
    .map((from) => {
      const cells = names.map((to) => {
        if (from === to) return '<td class="self"></td>'
        const x = find(from, to)
        if (!x) return '<td></td>'
        const tip = t(x.from === '*' ? 'page.tpl.cell_any' : 'page.tpl.cell', { from, to, name: x.name || x.to })
        return `<td class="${x.from === '*' ? 'g' : 'y'}" data-tip="${esc(tip)}" aria-label="${esc(tip)}">●</td>`
      })
      return `<tr><th scope="row">${pill(from)}</th>${cells.join('')}</tr>`
    })
    .join('')
  return `<div class="jmx-w"><table class="jmx"><thead>${head}</thead><tbody>${rows}</tbody></table></div>`
}
function stepTemplate() {
  const tp = S.v.template
  const cats = Object.entries(tp.categories || {})
    .map(([k, l]) => `<span class="jst ${CAT[k] || 'jn'}">${esc(l)}</span>`)
    .join(' ')
  const step = (s) => `<div class="jflow-s">${pill(s.name)}<span class="d">${esc(s.about)}</span></div>`
  const phases = [...new Set(tp.statuses.map((s) => s.phase).filter(Boolean))]
  const phase = (k) => `<div class="jphase ${esc(k)}"><div class="jlbl">${esc(en('phase', k))}</div><div class="jsteps">${tp.statuses.filter((s) => s.phase === k).map(step).join('')}</div></div>`
  const other = tp.statuses.filter((s) => !s.phase).map(step).join('')
  const roles = tp.roles
    .map((r) => `<tr><td><b>${esc(r.title)}</b><span class="d">${esc(r.about)}</span></td><td>${r.statuses.map(pill).join(' ')}</td><td class="d">${r.gate.length ? esc(t('page.tpl.gate', { gates: r.gate })) : ''}</td></tr>`)
    .join('')
  const types = tp.types.map((x) => `<b>${esc(x.name)}</b>${x.required ? ` ${esc(t('page.tpl.required'))}` : ''} — ${esc(x.about)}`).join('<br>')
  return `<div><h2>${esc(tp.title)}</h2><p>${esc(tp.about)}</p></div>
    ${phases.map(phase).join('')}
    <div class="jck-row">${other ? `<span class="jlbl">${esc(t('page.tpl.outside'))}</span>${other}` : ''}<span class="jlbl">${esc(t('page.tpl.initial'))}</span>${pill(tp.initial)}</div>
    <div class="jck-row"><span class="jlbl">${esc(t('page.tpl.categories'))}</span>${cats}</div>
    <div><div class="jlbl">${esc(t('page.tpl.transitions', { count: tp.transitions.length }))}</div>${matrix(tp)}</div>
    ${hint('sky', IC.info, [...(tp.rules || []), t('page.tpl.named')].map(esc).join(' '))}
    <div><div class="jlbl">${esc(t('page.tpl.columns'))}</div><div class="jflow">${tp.columns.map(pill).join('<span class="jarr">·</span>')}</div></div>
    <div><div class="jlbl">${esc(t('page.tpl.roles'))}</div><div class="tbl-w"><table class="jmap"><tbody>${roles}</tbody></table></div></div>
    <dl class="kv kv-code"><dt>${esc(t('page.tpl.types'))}</dt><dd>${types}</dd>${tp.rules?.length ? `<dt>${esc(t('page.tpl.rules'))}</dt><dd>${tp.rules.map(esc).join('<br>')}</dd>` : ''}</dl>`
}

// ── step 3: the project ────────────────────────────────────────────────────────────────────────────────────────
// Columns by hand: what to do on the board when the service could not put the columns in place.
function columnsHint(p, names, why) {
  const how = th(names.length ? 'page.cols.add' : 'page.cols.order', { key: p.key, names, order: S.v.template.columns.join(' → ') })
  const open = p.url ? `<a class="lnk wz-retry" href="${esc(p.url)}" target="_blank" rel="noreferrer">${esc(t('page.cols.open'))}</a>` : ''
  return hint('warn', IC.info, `${th('page.cols.manual')}${why ? ` ${esc(why)}` : ''} ${how}`, open)
}
// The columns after applying: all in place — a line; something did not go — what to do by hand.
function columnsResult(r, p) {
  const c = r?.columns || {}
  const created = c.created || []
  if (c.manual?.length) return columnsHint(p, c.manual, t('page.cols.why_manual'))
  if (c.error) return columnsHint(p, (c.create || []).filter((n) => !created.includes(n)), t('page.cols.why_error', { error: bare(c.error) }))
  if (c.ordered === false) return columnsHint(p, [], t('page.cols.why_order'))
  return created.length ? hint('ok', IC.ok, th('page.cols.added', { names: created })) : ''
}
// Apply the template: what goes in, a dry run (Jira validates, nothing is written), then the write after a yes.
function applyHtml(c, p) {
  const a = c.apply
  const st = W.apply || {}
  const busy = st.stage === 'dry' || st.stage === 'running'
  const what = [
    a.created?.length ? t('page.apply.create', { names: a.created }) : '',
    a.changed?.length ? t('page.apply.change', { list: a.changed.join('; ') }) : '',
    a.rulesChanged ? t('page.apply.rules', { transitions: plural(a.rulesChanged, 'page.n.transition') }) : '',
    a.same ? t('page.apply.same') : t('page.apply.transitions', { added: plural(a.added || 0, 'page.n.new'), dropped: plural(a.dropped || 0, 'page.n.drop') }),
    t('page.apply.initial', { status: a.initial }),
    a.columnsPlan?.create?.length ? t('page.apply.columns', { names: a.columnsPlan.create }) : t('page.apply.columns_order'),
    a.workflows ? t('page.apply.workflows', { count: a.workflows }) : '',
  ].filter(Boolean)
  const res = st.result
  const errors = (res?.errors || []).filter(Boolean)
  const warnings = (res?.warnings || []).filter(Boolean)
  const verdict =
    st.stage === 'dry'
      ? hint('sky', SPIN, th('page.apply.dry_busy'))
      : st.stage === 'running'
        ? hint('sky', SPIN, th('page.apply.running', { key: p.key }))
        : st.stage === 'error'
          ? hint('bad', IC.err, esc(st.error))
          : errors.length
            ? hint('bad', IC.err, th('page.apply.refused', { errors: errors.join('; ') }))
            : st.stage === 'done'
              ? `${hint('ok', IC.ok, th('page.apply.done', { key: p.key }))}${columnsResult(res, p)}`
              : res
                ? hint('ok', IC.ok, `${th('page.apply.dry_ok')}${warnings.length ? ` ${th('page.apply.warnings', { list: warnings.join('; ') })}` : ''}`)
                : ''
  const ask =
    st.stage === 'confirm'
      ? `<div class="jask">${hint('warn', IC.err, th('page.apply.confirm', { key: p.key }))}<div class="row"><button type="button" class="btn" data-flow="no">${esc(t('page.cancel'))}</button><button type="button" class="btnp" data-flow="apply">${IC.jira}${esc(t('page.apply.yes'))}</button></div></div>`
      : ''
  const buttons =
    a.blocked || st.stage === 'done' || ask
      ? ''
      : `<div class="row"><button type="button" class="btn" data-flow="dry" ${busy ? 'disabled' : ''}>${IC.ok}${esc(t('page.apply.dry'))}</button><button type="button" class="btnp" data-flow="ask" ${busy ? 'disabled' : ''}>${IC.jira}${esc(t('page.apply.go', { key: p.key }))}</button></div>`
  return `<div class="jplan"><div class="jlbl">${esc(t('page.apply.title'))}</div>
    <ul class="jwhat">${what.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    ${a.blocked ? hint('bad', IC.lock, esc(a.blocked)) : ''}${buttons}${ask}${verdict}
    ${a.columnsPlan?.manual?.length ? columnsHint(p, a.columnsPlan.manual, t('page.cols.why_exist')) : ''}</div>`
}
// Only what a person does in Jira is left: the plan, who can make each step.
function planHtml(c) {
  const steps = c.plan.map((s) => `<li><div><span>${esc(s.what)}</span><span class="jvia ${VIA[s.via] || 'sky'}">${esc(en('via', s.via))}</span></div></li>`).join('')
  return `<div class="jplan"><div class="jlbl">${esc(t('page.plan.title', { steps: plural(c.plan.length, 'page.n.step') }))}</div>
    <ol class="wz-ol">${steps}</ol>
    ${hint('mute', IC.info, th('page.plan.only'))}</div>`
}
// A new project from the template: an empty team-managed Jira project and the template in it; only a Jira admin.
function newProjectHtml() {
  const v = S.v
  const mk = W.mk
  const title = `<b>${esc(t('page.mk.title'))}</b>`
  if (!v.canCreate) return `<div class="jpc off"><span></span><span class="jpk">+</span><span class="jpt">${title}<span class="d">${esc(t('page.mk.no_right'))}</span></span><span></span></div>`
  if (!mk.open) return `<button type="button" class="jpc jnew" data-flow="mkopen"><span></span><span class="jpk">+</span><span class="jpt">${title}<span class="d">${esc(t('page.mk.about'))}</span></span><span></span></button>`
  const keyOk = /^[A-Z][A-Z0-9]{1,9}$/.test(mk.key)
  const taken = v.projects.some((p) => p.key === mk.key)
  const check = mk.key && !keyOk ? hint('warn', IC.err, th('page.mk.bad_key')) : taken ? hint('warn', IC.err, th('page.mk.taken', { key: mk.key })) : ''
  const state = mk.busy ? hint('sky', SPIN, th('page.mk.busy', { key: mk.key })) : mk.error ? hint('bad', IC.err, esc(mk.error)) : ''
  return `<div class="jpc jnew on"><span></span><span class="jpk">+</span><div class="jmk">
      <div class="au-row2"><label class="fldc"><span class="lbl">${esc(t('page.mk.key'))}</span><input class="inp mono" data-flow="mkkey" value="${esc(mk.key)}" placeholder="${esc(t('page.mk.key_ph'))}" maxlength="10" spellcheck="false" autocomplete="off"></label><label class="fldc"><span class="lbl">${esc(t('page.mk.name'))}</span><input class="inp" data-flow="mkname" value="${esc(mk.name)}" placeholder="${esc(t('page.mk.name_ph'))}" maxlength="80" autocomplete="off"></label></div>
      ${check}${state}
      <div class="row"><button type="button" class="btn" data-flow="mkclose" ${mk.busy ? 'disabled' : ''}>${esc(t('page.cancel'))}</button><button type="button" class="btnp" data-flow="mkgo" data-enter ${mk.busy || !keyOk || taken ? 'disabled' : ''}>${IC.jira}${esc(t('page.mk.go'))}</button></div>
    </div><span></span></div>`
}
function stepProject() {
  const v = S.v
  const head = `<div><h2>${esc(t('page.proj.title'))}</h2><p>${esc(t('page.proj.about'))}</p></div>`
  if (!v.account.token) return `${head}${hint('warn', IC.err, th('error.no_login'))}`
  const cards = v.projects
    .map((p) => {
      const issues = S.check[p.key]?.project?.issues ?? p.issues ?? '—'
      const kind = !p.kind ? '' : has(`page.kind.${p.kind}`) ? t(`page.kind.${p.kind}`) : p.kind
      const managed = p.managed && has(`page.managed.${p.managed}`) ? t(`page.managed.${p.managed}`) : ''
      const d = [[kind, managed].filter(Boolean).join(', '), t('page.proj.issues', { count: issues })].filter(Boolean).join(' · ')
      const on = p.key === W.project
      return `<label class="jpc${on ? ' on' : ''}"><input type="radio" name="jproj" data-flow="proj" value="${esc(p.key)}" ${on ? 'checked' : ''}><span class="jpk">${esc(p.key)}</span><span class="jpt"><b>${esc(p.name)}</b><span class="d">${esc(d)}</span></span><span class="jck-row">${sum(checkOf(p.key))}</span></label>`
    })
    .join('')
  const c = S.check[W.project]
  const list = !W.project
    ? hint('sky', IC.info, th('page.proj.choose'))
    : !c
      ? W.error
        ? hint('bad', IC.err, esc(W.error))
        : `<div class="note">${esc(t('page.proj.checking'))}</div>`
      : `<ul class="jchk">${c.items.map((i) => `<li class="${esc(i.state)}"><span class="ic2" role="img" aria-label="${esc(en('state', i.state))}">${MARK[i.state] || IC.q}</span><span><b>${esc(i.title)}</b><span class="d">${esc(i.detail)}</span></span></li>`).join('')}</ul>`
  const src = !c
    ? ''
    : W.rechecking
      ? `<div class="hintl">${SPIN} ${esc(t('page.proj.rechecking'))}</div>`
      : `<div class="hintl">${esc(t('page.proj.checked', { time: clock(c.at) }))} <button type="button" class="lnk" data-flow="recheck">${esc(t('page.proj.recheck'))}</button></div>`
  // Something to apply (or applying has just gone) — the block "Apply the template"; only steps by hand — the plan.
  const act = !c ? '' : c.apply && (W.apply || c.plan.some((x) => x.via === 'api')) ? applyHtml(c, boardOf(W.project)) : c.plan.length ? planHtml(c) : hint('ok', IC.ok, th('page.proj.nothing'))
  return `${head}<div class="jpcs">${cards}${newProjectHtml()}</div>${list}${src}${act}`
}

// ── step 4: roles — who leads an issue in which statuses and who may move it into a gate ──────────────────────────
// A role: its people as chips (× removes one, the last one stays), "+ person" — people of the project not in it yet,
// and whom to assign: one of the role or nobody — then anyone of the role takes the issue.
const NOBODY = '-'
function roleCell(r, x) {
  const label = (u) => (u.accountId === r.me.accountId ? t(r.admin ? 'page.roles.me_admin' : 'page.roles.me', { name: u.name }) : u.name)
  if (r.single) return `<b>${esc(x.assignName)}</b>`
  const ids = new Set(x.people.map((u) => u.accountId))
  const remove = esc(t('page.roles.remove'))
  const chips = x.people
    .map((u) => `<span class="jchip">${esc(u.name)}${x.people.length > 1 ? `<button type="button" class="x" data-flow="roledel" data-role="${esc(x.key)}" data-id="${esc(u.accountId)}" data-tip="${remove}" aria-label="${remove}">×</button>` : ''}</span>`)
    .join('')
  const rest = r.users.filter((u) => !ids.has(u.accountId))
  const opt = (value, text, on = false) => `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(text)}</option>`
  const add = rest.length ? `<span class="sel add"><select data-flow="roleadd" data-role="${esc(x.key)}" aria-label="${esc(t('page.roles.add'))}">${opt('', t('page.roles.add'), true)}${rest.map((u) => opt(u.accountId, label(u))).join('')}</select></span>` : ''
  const cur = x.assign || NOBODY
  const who = `<span class="sel"><select data-flow="roleassign" data-role="${esc(x.key)}" aria-label="${esc(t('page.roles.assign'))}">${x.people.map((u) => opt(u.accountId, label(u), u.accountId === cur)).join('')}${opt(NOBODY, t('page.roles.nobody'), cur === NOBODY)}</select></span>`
  return `<div class="jppl">${chips}${add}</div><div class="jasg"><span class="d">${esc(t('page.roles.assign'))}</span>${who}</div>`
}
function stepRoles() {
  const key = W.project
  const r = S.roles[key]
  const title = `<h2>${esc(t('page.roles.title'))}</h2>`
  if (!key) return `<div>${title}</div>${hint('sky', IC.info, th('page.need_project'))}`
  if (!r) return `<div>${title}</div>${W.error ? hint('bad', IC.err, esc(W.error)) : `<div class="note">${esc(t('page.roles.reading'))}</div>`}`
  const gates = [...new Set(S.v.template.roles.flatMap((x) => x.gate))]
  const rows = r.roles
    .map((x) => `<tr><td><b>${esc(x.title)}</b><span class="d">${esc(x.about)}</span></td><td>${x.statuses.map(pill).join(' ')}</td><td>${roleCell(r, x)}${x.gate.length ? `<span class="d">${esc(t('page.roles.gate', { gates: x.gate }))}</span>` : ''}</td></tr>`)
    .join('')
  const c = S.check[key]
  const differ = c?.items?.find((i) => i.key === 'rules')?.state === 'warn'
  const rules = differ
    ? `${hint('warn', IC.info, th('page.roles.differ', { key }))}<div class="row"><button type="button" class="btnp" data-flow="rules" ${R.busy ? 'disabled' : ''}>${IC.jira}${esc(t('page.roles.apply', { key }))}</button></div>`
    : c?.source === 'live'
      ? hint('mute', IC.ok, th('page.roles.follow', { key }))
      : ''
  const going = R.busy
    ? hint('sky', SPIN, th('page.roles.busy', { key }))
    : R.error
      ? hint('bad', IC.err, th('page.roles.failed', { error: R.error }))
      : R.result && !R.result.applied
        ? hint('bad', IC.err, th('page.roles.refused', { errors: (R.result.errors || []).join('; ') }))
        : ''
  return `<div>${title}<p>${esc(t('page.roles.about', { gates }))}</p></div>
    ${r.single ? hint('ok', IC.ok, th(r.admin ? 'page.roles.single_admin' : 'page.roles.single', { key, name: r.me.name })) : ''}
    <div class="tbl-w"><table class="jmap jroles"><thead><tr><th>${esc(t('page.roles.role'))}</th><th>${esc(t('page.roles.statuses'))}</th><th>${esc(t('page.roles.people'))}</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${W.rolesSaved ? hint('ok', IC.ok, th('page.roles.saved')) : ''}
    ${rules}
    ${going}`
}

// ── step 5: the sync of the items ──────────────────────────────────────────────────────────────────────────────
// The issue of an item: its key as a link (red with an error, the text in the tooltip); being written — a spinner; not
// written while the sync is on — "Add".
function keyHtml(i) {
  const j = i.jira
  if (j?.key) {
    const tip = j.error ? t('page.key.failed', { error: j.error }) : [t('page.key.tip', { key: j.key }), j.applied, j.parent ? t('page.key.epic', { parent: j.parent }) : ''].filter(Boolean).join(' · ')
    return j.url ? `<a class="jkey${j.error ? ' bad' : ''}" href="${esc(j.url)}" target="_blank" rel="noreferrer" data-tip="${esc(tip)}">${esc(j.key)}</a>` : `<span class="jkey${j.error ? ' bad' : ''}" data-tip="${esc(tip)}">${esc(j.key)}</span>`
  }
  if (j?.error) return `<span class="jkey bad" data-tip="${esc(j.error)}">${esc(t('page.key.error'))}</span>`
  if (j?.pending) return `<span class="jkey" data-tip="${esc(t('page.key.pending'))}" aria-label="${esc(t('page.key.pending'))}">${SPIN}</span>`
  if (syncOn() && j?.skip) return `<button type="button" class="lnk" data-flow="sync-add" data-id="${esc(i.id)}" data-tip="${esc(t('page.key.add_tip'))}">${esc(t('page.key.add'))}</button>`
  return ''
}
// An item: its summary, its id when it says something more, the status it is in, its issue.
const idLine = (i) => (i.id !== i.summary ? `<span class="d mono">${esc(i.id)}</span>` : '')
const itemRow = (i) => `<div class="jfr"><span class="jk">${i.jira?.key ? IC.link : IC.new}</span><span class="jt"><b>${esc(i.summary)}</b>${idLine(i)}</span><span class="jto">${pill(i.status)}${keyHtml(i)}</span></div>`
const feedHtml = (f) => `<div class="jfeed">${f.items.map(itemRow).join('')}</div>${f.total > f.items.length ? `<div class="hintl">${esc(t('page.sync.shown', { shown: f.items.length, total: f.total }))}</div>` : ''}`
// An epic for the issues (the Parent field in Jira): epics are made in Jira by hand, here — its key, the service checks
// it in Jira. Set — which one and whether Jira still has it; "Remove" — new issues go without an epic, earlier ones stay.
function epicHtml(p) {
  const e = S.epic
  const f = W.epic
  const drop = `<button type="button" class="lnk wz-retry" data-flow="epic-clear" ${f.busy ? 'disabled' : ''}>${esc(t('page.epic.remove'))}</button>`
  const link = e?.url ? `<a class="jkey" href="${esc(e.url)}" target="_blank" rel="noreferrer">${esc(e.key)}</a>` : `<span class="jkey">${esc(e?.key)}</span>`
  const cur = !e
    ? `<div class="hintl">${SPIN} ${esc(t('page.epic.reading'))}</div>`
    : !e.key
      ? ''
      : e.ok
        ? hint('ok', IC.ok, th(e.status ? 'page.epic.ok_status' : 'page.epic.ok', { summary: e.summary, status: e.status }, { link }), drop)
        : hint('warn', IC.err, th('page.epic.bad', { key: e.key, problem: bare(e.problem) }), drop)
  return `<div class="jlogin"><div><div class="jlbl">${esc(t('page.epic.title'))}</div><div class="hintl">${esc(t('page.epic.about', { key: p.key }))} ${esc(t(syncOn() ? 'page.epic.what_on' : 'page.epic.what_off'))}</div></div>
      ${cur}
      <div class="jepic"><input class="inp mono" data-flow="epic" value="${esc(f.key)}" placeholder="${esc(`${p.key}-12`)}" maxlength="24" spellcheck="false" autocomplete="off" aria-label="${esc(t('page.epic.title'))}"><button type="button" class="btnp" data-flow="epic-save" data-enter ${f.busy || !f.key ? 'disabled' : ''}>${f.busy ? SPIN : IC.ok}${esc(t(e?.key ? 'page.epic.change' : 'page.epic.save'))}</button></div>
      ${f.error ? hint('bad', IC.err, esc(f.error)) : ''}
    </div>`
}
// Off — what happens, which items that exist already go at once; on — since when, how many issues, the items and
// their issues. The epic — in both.
function stepSync() {
  const f = S.feed
  if (!f) return `<div class="note">${esc(t('page.sync.reading'))}</div>`
  const p = target()
  const s = f.sync || {}
  const how = hint('sky', IC.info, th('page.sync.how'))
  if (s.on) {
    const skip = f.items.filter((i) => i.jira?.skip).length
    const bad = f.items.filter((i) => i.jira?.error).length
    return `<div class="okbig"><span class="ic6">${IC.jira}</span><div><h2>${esc(t('page.sync.on_title', { project: s.project }))}</h2><p>${esc(t(s.epic ? 'page.sync.on_sub_epic' : 'page.sync.on_sub', { site: s.site, since: stamp(s.since), epic: s.epic }))}</p></div></div>
      <div class="jck-row"><span class="jck ok">${esc(t('page.sync.in_jira', { count: f.linked }))}</span>${skip ? `<span class="jck unknown">${esc(t('page.sync.skipped', { count: skip }))}</span>` : ''}${bad ? `<span class="jck bad">${esc(t('page.sync.errors', { count: bad }))}</span>` : ''}</div>
      ${p ? epicHtml(p) : ''}
      ${f.total ? feedHtml(f) : hint('mute', IC.info, th('page.sync.empty'))}
      ${how}
      <div class="row"><button type="button" class="btn" data-flow="sync-off" ${W.syncBusy ? 'disabled' : ''}>${esc(t('page.sync.off'))}</button></div>`
  }
  if (!p) return `<div><h2>${esc(t('page.sync.title', { key: 'Jira' }))}</h2></div>${hint('sky', IC.info, th('page.need_project'))}${how}`
  const c = checkOf(p.key)
  const ready = c.source === 'live' && fits(c)
  const old = f.items.filter((i) => !i.jira?.key)
  const n = [...W.pick].filter((x) => old.some((i) => i.id === x)).length
  const list = old.length
    ? `<div><div class="jlbl">${esc(t('page.sync.pick'))}</div><div class="jfeed">${old.map((i) => `<label class="jfr jpick"><input type="checkbox" data-flow="pick" value="${esc(i.id)}" ${W.pick.has(i.id) ? 'checked' : ''}><span class="jt"><b>${esc(i.summary)}</b>${idLine(i)}</span><span class="jto">${pill(i.status)}</span></label>`).join('')}</div></div>`
    : ''
  const label = n ? t('page.sync.on_add', { issues: plural(n, 'page.n.issue_acc') }) : t('page.sync.on')
  return `<div><h2>${esc(t('page.sync.title', { key: p.key }))}</h2><p>${esc(t('page.sync.about', { key: p.key, site: S.v.site }))}</p></div>
    ${epicHtml(p)}
    ${list}
    ${!ready ? hint('warn', IC.err, th('page.sync.not_ready', { key: p.key })) : ''}
    ${W.syncError ? hint('bad', IC.err, esc(W.syncError)) : ''}
    <div class="row"><button type="button" class="btnp" data-flow="sync-on" ${!ready || W.syncBusy ? 'disabled' : ''}>${W.syncBusy ? SPIN : IC.jira}${esc(label)}</button></div>
    ${how}`
}

// ── the steps: a mark by how things stand, not by where the person has been ──────────────────────────────────────
// ok — in order, act — needs an action, wait — still checking, info — nothing to do and nothing to check. The
// template only tells — always ok.
function stateOf(n) {
  const v = S.v
  const c = S.check[W.project]
  const live = c?.source === 'live'
  if (n === CONN) return !v.account.token ? 'act' : !W.project ? (v.connected ? 'ok' : 'act') : c ? (live ? 'ok' : 'act') : W.error ? 'act' : 'wait'
  if (n === PROJ) {
    if (!W.project) return 'act'
    if (!c) return W.error ? 'act' : 'wait'
    // Transition rules are the Roles step; issues in the project and optional types are information.
    return c.items.some((i) => i.key !== 'rules' && i.state === 'bad') || c.plan.some((x) => x.key !== 'rules') ? 'act' : live ? 'ok' : 'info'
  }
  if (n === ROLES) {
    if (!W.project) return 'info'
    if (!c) return W.error ? 'info' : 'wait'
    const r = c.items.find((i) => i.key === 'rules')
    return !r ? 'info' : r.state === 'ok' ? 'ok' : 'act'
  }
  if (n === SYNC) return syncOn() ? 'ok' : 'info'
  return 'ok'
}
// The step to open: the first one that needs an action (or is still being checked); all in order — the last one.
function firstStep() {
  for (let n = 1; n < STEPS.length; n++) if (['act', 'wait'].includes(stateOf(n))) return n
  return STEPS.length
}
const STEP_MARK = { ok: ['done', '✓', 'page.mark.ok'], act: ['need', '!', 'page.mark.act'], wait: ['wait', SPIN, 'page.mark.wait'] }
function pageHtml() {
  const v = S.v
  const a = v.account
  const steps = STEPS.map((k, i) => {
    const n = i + 1
    const [cls, nb, tip] = STEP_MARK[stateOf(n)] || ['', String(n), '']
    const sub = k === 'template' ? v.template.title : t(`page.step.${k}.sub`)
    const cur = W.step === n
    return `<button type="button" class="wz-st${cur ? ' cur' : ''}${cls ? ` ${cls}` : ''}" data-flow="go" data-v="${n}"${tip ? ` data-tip="${esc(t(tip))}"` : ''}${cur ? ' aria-current="step"' : ''}><span class="nb">${nb}</span><span><b>${esc(t(`page.step.${k}.title`))}</b><span class="d">${esc(sub)}</span></span></button>`
  }).join('')
  const body = [stepConnection, stepTemplate, stepProject, stepRoles, stepSync][W.step - 1]()
  const back = W.step > 1 ? `<button type="button" class="btn" data-flow="back">${esc(t('page.back'))}</button>` : ''
  const next = W.step < STEPS.length ? `<button type="button" class="btnp" data-flow="next">${esc(t('page.next'))}</button>` : ''
  const who = a.token ? `${a.email} · ${v.site}` : t('page.account.none')
  return `<header class="top"><span class="dic">${IC.jira}</span><div class="dt"><h1>${esc(t('page.title'))}</h1><div class="dsub">${esc(t('page.about', { template: v.template.title }))}</div></div><span class="acct${a.token ? '' : ' off'}">${esc(who)}</span></header>
    <div class="wz"><nav class="wz-steps" aria-label="${esc(t('page.steps'))}"><div class="wz-rail">${steps}<div class="wz-free"><b>${esc(t('page.free.title'))}</b><br>${esc(t('page.free.text'))}</div></div></nav>
    <main class="wz-pane"><div class="wz-main">${body}</div><div class="wz-foot">${back}<span class="sp"></span>${next}</div></main></div>`
}
// A render of the same step keeps the place on the page: the answer of a check stays in front of the eyes; another
// step starts from its top.
let shown = 0
function draw() {
  if (!S.v) return
  // The page has just opened and the person has not moved: go to the step that needs an action as soon as Jira
  // shows it. After that the steps do not jump: what applying did stays in front of the eyes.
  if (W.auto) {
    const n = firstStep()
    if (stateOf(n) !== 'wait') W.auto = false
    if (n !== W.step) return go(n, true)
  }
  render($('#app'), pageHtml())
  // On a narrow screen the steps are a row that scrolls: the current one in its middle (the row only, not the page).
  const rail = $('.wz-rail')
  const cur = $('.wz-st.cur')
  if (rail && cur && rail.scrollWidth > rail.clientWidth) rail.scrollLeft = cur.getBoundingClientRect().left - rail.getBoundingClientRect().left - (rail.clientWidth - cur.offsetWidth) / 2
  if (shown && shown !== W.step) {
    const top = $('.wz')?.getBoundingClientRect().top ?? 0
    if (top < 0) scrollBy({ top: top - 16 })
  }
  shown = W.step
}
function go(n, auto = false) {
  if (!auto) W.auto = false
  W.step = Math.min(STEPS.length, Math.max(1, n))
  if (W.step === PROJ) loadCheck(W.project)
  if (W.step === ROLES) {
    loadRoles(W.project)
    loadCheck(W.project)
  }
  if (W.step === SYNC) {
    loadCheck(W.project)
    loadFeed()
    loadEpic()
  }
  draw()
}

// ── data ───────────────────────────────────────────────────────────────────────────────────────────────────────
// The project as Jira has it now (up to half a minute); force — again, after applying or on "Check again".
const reading = new Map()
async function loadCheck(key, force = false) {
  if (!key || (S.check[key] && !force)) return
  if (reading.has(key) && !force) return reading.get(key)
  W.error = ''
  const once = (async () => {
    try {
      S.check[key] = await api(`flow/check?project=${encodeURIComponent(key)}`)
    } catch (e) {
      W.error = e.message
    }
  })()
  reading.set(key, once)
  await once
  if (reading.get(key) === once) reading.delete(key)
  draw()
}
// "Check again": the progress is seen, the outcome comes as a toast.
async function recheck() {
  if (!W.project || W.rechecking) return
  W.rechecking = true
  draw()
  await loadCheck(W.project, true)
  W.rechecking = false
  draw()
  const c = S.check[W.project]
  if (c) toast(fits(c) ? t('page.proj.fits', { key: W.project }) : t('page.proj.to_fix', { key: W.project, count: c.items.filter((i) => i.state === 'bad' || (i.state === 'warn' && i.key !== 'issues' && i.key !== 'types')).length }))
}
async function loadRoles(key, force = false) {
  if (!key || (S.roles[key] && !force)) return
  try {
    S.roles[key] = await api(`flow/roles?project=${encodeURIComponent(key)}`)
  } catch (e) {
    W.error = e.message
  }
  draw()
}
// A change of a role: a person in or out, another assignee — the whole role goes to the service and is saved there.
async function saveRole(role, change) {
  const key = W.project
  const x = S.roles[key]?.roles.find((y) => y.key === role)
  if (!x) return
  let people = x.people.map((u) => u.accountId)
  let assign = x.assign
  if (change.add) people = [...people, change.add]
  if (change.del) {
    people = people.filter((id) => id !== change.del)
    if (assign === change.del) assign = people[0] || null
  }
  if ('assign' in change) assign = change.assign === NOBODY ? null : change.assign
  try {
    S.roles[key] = await api('flow/roles', { project: key, roles: { [role]: { people, assign } } })
    W.rolesSaved = true
  } catch (e) {
    toast(e.message)
  }
  draw()
  await loadCheck(key, true)
}
// The rules of the roles into Jira: the template is applied as it is (only what differs is written).
async function applyRules(key) {
  if (!key || R.busy) return
  Object.assign(R, { busy: true, result: null, error: '' })
  draw()
  try {
    R.result = await api('flow/apply', { project: key })
    if (R.result.applied) {
      toast(t('page.apply.toast', { key }))
      await loadCheck(key, true)
    }
  } catch (e) {
    R.error = e.message
  }
  R.busy = false
  draw()
}
// A new project from the template: create it, apply the template, make it the project of the space.
async function createProject() {
  const mk = W.mk
  Object.assign(mk, { busy: true, error: '' })
  draw()
  try {
    const r = await api('flow/create', { key: mk.key, name: mk.name || mk.key })
    toast(r.applied ? t('page.mk.toast_ok', { key: r.created }) : t('page.mk.toast_part', { key: r.created, why: r.errors?.length ? r.errors.join('; ') : t('page.mk.not_applied') }))
    S.v = await api('flow')
    S.link = await api('space/link', { project: r.created })
    S.epic = null
    Object.assign(W, { project: r.created, apply: { stage: r.applied ? 'done' : 'checked', result: r }, mk: newMk(), rolesSaved: false, epic: newEpic() })
    await loadCheck(r.created, true)
  } catch (e) {
    Object.assign(mk, { busy: false, error: e.message })
  }
  draw()
}
// Apply the template: dryRun — Jira validates, nothing is written; otherwise the write (after a yes on the page).
async function applyTemplate(dryRun) {
  const key = W.project
  W.apply = { stage: dryRun ? 'dry' : 'running' }
  draw()
  try {
    const result = await api('flow/apply', { project: key, dryRun })
    W.apply = { stage: !dryRun && result.applied ? 'done' : 'checked', result }
    if (!dryRun && result.applied) {
      toast(t('page.apply.toast', { key }))
      await loadCheck(key, true)
    }
  } catch (e) {
    W.apply = { stage: 'error', error: e.message }
  }
  draw()
}
// The items with their issues. A render only when something changed and it is seen: an event of the sync while
// another step is open does not close a list the person has opened there.
async function loadFeed() {
  let f
  try {
    f = await api('space/feed')
  } catch {
    f = { total: 0, items: [], byStatus: {}, sync: null, linked: 0 }
  }
  const was = S.feed
  S.feed = f
  if (f.sync) S.link = f.sync
  if (was && JSON.stringify(f) === JSON.stringify(was)) return
  if (!was || W.step === SYNC || Boolean(was.sync?.on) !== Boolean(f.sync?.on)) draw()
}
let feedTimer = 0
const feedSoon = () => {
  clearTimeout(feedTimer)
  feedTimer = setTimeout(loadFeed, FEED_SETTLE_MS)
}
// The epic as Jira has it now.
async function loadEpic() {
  if (!target()) return
  try {
    S.epic = await api('space/epic')
  } catch {
    S.epic = { key: null }
  }
  draw()
}
// Set the epic (the service checks it in Jira; with the sync on, issues already there go under it) or remove it ('').
async function saveEpic(epic) {
  const f = W.epic
  if (f.busy) return
  Object.assign(f, { busy: true, error: '' })
  draw()
  try {
    const { epicInfo, ...st } = await api('space/epic', { epic })
    S.epic = epicInfo
    S.link = { ...S.link, ...st }
    f.key = ''
    toast(st.epic ? t('page.epic.toast_set', { epic: st.epic }) : t('page.epic.toast_clear'))
  } catch (e) {
    f.error = e.message
  }
  f.busy = false
  draw()
  loadFeed()
}
// The Jira project of the space: the service keeps it; the check and the items follow it.
async function setTarget(key) {
  Object.assign(W, { project: key, apply: null, rolesSaved: false, auto: false, epic: newEpic() })
  Object.assign(R, { result: null, error: '' })
  S.epic = null
  draw()
  loadCheck(key)
  try {
    S.link = await api('space/link', { project: key })
  } catch (e) {
    toast(e.message)
  }
  loadFeed()
}
// Sync on (with the items that exist already to add at once) or off.
async function setSync(body) {
  Object.assign(W, { syncBusy: true, syncError: '' })
  draw()
  try {
    await api('space/sync', body)
    if (body.on) toast(t('page.sync.toast_on', { key: target()?.key || 'Jira' }))
    W.pick.clear()
  } catch (e) {
    W.syncError = e.message
  }
  W.syncBusy = false
  await loadFeed()
  draw()
}
async function syncAdd(id) {
  try {
    await api('space/add', { id })
  } catch (e) {
    toast(e.message)
  }
  loadFeed()
}
// The login: checked against Jira before it is saved; forgotten. After it — everything about Jira again.
async function login(route, body) {
  Object.assign(W.login, { busy: true, error: '' })
  draw()
  try {
    S.v = await api(route, body)
    Object.assign(W.login, { site: S.v.account.site || W.login.site, email: S.v.account.email || W.login.email, token: '' })
    Object.assign(S, { check: {}, roles: {}, epic: null })
    Object.assign(R, { result: null, error: '' })
    S.link = await api('space').catch(() => null)
    Object.assign(W, { project: S.link?.project || null, apply: null, rolesSaved: false, error: '' })
    loadCheck(W.project, true)
    loadFeed()
    toast(t(route === 'flow/logout' ? 'page.login.toast_out' : 'page.login.toast_in'))
  } catch (e) {
    W.login.error = e.message
  }
  W.login.busy = false
  draw()
}

// ── what the person does ───────────────────────────────────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  const el = e.target.closest?.('[data-flow]')
  if (!el || el.disabled || el.matches('input, select')) return
  e.preventDefault()
  const a = el.dataset.flow
  if (a === 'go') go(Number(el.dataset.v))
  else if (a === 'next') go(W.step + 1)
  else if (a === 'back') go(W.step - 1)
  else if (a === 'lgsave') login('flow/login', { site: W.login.site, email: W.login.email, token: W.login.token })
  else if (a === 'lgforget') login('flow/logout', {})
  else if (a === 'recheck') recheck()
  else if (a === 'dry') applyTemplate(true)
  else if (a === 'apply') applyTemplate(false)
  else if (a === 'ask' || a === 'no') {
    W.apply = a === 'ask' ? { ...W.apply, stage: 'confirm' } : W.apply?.result ? { stage: 'checked', result: W.apply.result } : null
    draw()
  } else if (a === 'mkopen' || a === 'mkclose') {
    W.mk = { ...newMk(), open: a === 'mkopen' }
    draw()
  } else if (a === 'mkgo') createProject()
  else if (a === 'roledel') saveRole(el.dataset.role, { del: el.dataset.id })
  else if (a === 'rules') applyRules(W.project)
  else if (a === 'sync-on') setSync({ on: true, ids: [...W.pick] })
  else if (a === 'sync-off') setSync({ on: false })
  else if (a === 'sync-add') syncAdd(el.dataset.id)
  else if (a === 'epic-save') saveEpic(W.epic.key)
  else if (a === 'epic-clear') saveEpic('')
})
document.addEventListener('change', (e) => {
  const el = e.target
  const a = el.dataset?.flow
  if (a === 'proj') setTarget(el.value)
  else if (a === 'roleadd' && el.value) saveRole(el.dataset.role, { add: el.value })
  else if (a === 'roleassign') saveRole(el.dataset.role, { assign: el.value })
  else if (a === 'pick') {
    if (el.checked) W.pick.add(el.value)
    else W.pick.delete(el.value)
    draw()
  }
})
// Fields: a new project key and an epic key — capitals; the page is drawn again with the caret in the same field.
const FIELDS = {
  lgsite: (v) => (W.login.site = v.trim()),
  lgemail: (v) => (W.login.email = v.trim()),
  lgtoken: (v) => (W.login.token = v.trim()),
  mkkey: (v) => (W.mk.key = v.toUpperCase().replace(/[^A-Z0-9]/g, '')),
  mkname: (v) => (W.mk.name = v),
  epic: (v) => (W.epic.key = v.toUpperCase().replace(/[^A-Z0-9-]/g, '')),
}
function typed(e) {
  const set = FIELDS[e.target.dataset?.flow]
  if (!set) return
  set(e.target.value)
  draw()
}
document.addEventListener('input', (e) => !e.isComposing && typed(e))
document.addEventListener('compositionend', typed)

// ── start: the labels, the overview, the space; then the step that needs an action ────────────────────────────────
async function boot() {
  const app = $('#app')
  try {
    await loadLabels()
    document.title = t('page.title')
    S.v = await api('flow')
  } catch (e) {
    app.innerHTML = `<div class="page-err">${esc(has('page.down') ? t('page.down', { error: e.message }) : e.message)}</div>`
    return
  }
  S.link = await api('space').catch(() => null)
  Object.assign(W.login, { site: S.v.account.site || '', email: S.v.account.email || '' })
  W.project = S.link?.project || null
  W.auto = true
  app.removeAttribute('aria-busy')
  loadCheck(W.project)
  loadFeed()
  go(firstStep(), true)
  // What the sync did: the items again (a few events in a row — one read).
  onEvent('jira', feedSoon)
  document.addEventListener('visibilitychange', () => !document.hidden && feedSoon())
  // Items come from the host without events while the sync is off: the Sync step reads them now and then.
  setInterval(() => !document.hidden && W.step === SYNC && loadFeed(), FEED_EVERY_MS)
}
boot()
