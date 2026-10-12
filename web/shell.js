// jira-flow page shell: the helpers of the wizard (web/flow.js) — the API and its envelope, the labels of the service in
// its language (GET api/flow/labels: enum labels and texts by key), escaping, plural forms, icons, toasts, tooltips, a
// render that keeps the focus and the caret in the field being typed in, Enter in a field pressing its [data-enter]
// button, and the event stream api/events (event jira — what the sync did). Paths are relative: the page works under
// any prefix a host serves it at.

export const $ = (s, r = document) => r.querySelector(s)
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// A call of the service: GET without a body, POST with one (and the header x-flow: 1 — the server takes no POST
// without it). The answer is { ok: true, result } or { ok: false, error, code }; an error is thrown with its text.
export async function api(route, body) {
  const post = body !== undefined
  const res = await fetch(`api/${route}`, { method: post ? 'POST' : 'GET', headers: post ? { 'x-flow': '1', 'content-type': 'application/json' } : {}, body: post ? JSON.stringify(body) : undefined, cache: 'no-store' })
  const j = await res.json().catch(() => null)
  if (!j?.ok) throw Object.assign(new Error(j?.error || `HTTP ${res.status}`), { code: j?.code || null })
  return j.result
}

// ── texts for people: everything a person reads comes from the labels of the service ─────────────────────────────
const L = { lang: 'en', missing: false, enum: {}, text: {} }
export async function loadLabels() {
  Object.assign(L, await api('flow/labels'))
  document.documentElement.lang = L.lang
  return L
}
// The language of numbers, dates and plural forms: the one the texts are in (a language without a locale — English).
export const lang = () => (L.missing ? 'en' : L.lang)
export const has = (key) => Object.hasOwn(L.text, key)
const raw = (key) => L.text[key] ?? key
const fill = (v) => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v))
const VAR = /\{\{(\w+)\}\}/g
// Plain text by key with {{var}} filled in (an array — a comma-separated list); into markup only through esc().
export const t = (key, vars = {}) => raw(key).replace(/\*\*/g, '').replace(VAR, (_, k) => fill(vars[k]))
// The same text as markup: escaped, **…** — bold; html — vars that are markup the page made itself (already escaped).
export function th(key, vars = {}, html = {}) {
  return esc(raw(key))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(VAR, (_, k) => (Object.hasOwn(html, k) ? html[k] : esc(fill(vars[k]))))
}
// The label of an enum value: en('state', 'ok').
export const en = (name, value) => L.enum?.[name]?.[value] ?? String(value)
// A count with its word. The text of the key holds the forms split by "|" in the order zero, one, two, few, many,
// other — only the categories the language has (Intl.PluralRules); a missing form is the last one. {{count}} — n.
const ORDER = ['zero', 'one', 'two', 'few', 'many', 'other']
const rulesOf = new Map()
export function plural(n, key, vars = {}) {
  const l = lang()
  if (!rulesOf.has(l)) {
    const r = new Intl.PluralRules(l)
    rulesOf.set(l, { r, cats: [...r.resolvedOptions().pluralCategories].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)) })
  }
  const { r, cats } = rulesOf.get(l)
  const forms = raw(key).split('|')
  const form = forms[Math.min(Math.max(0, cats.indexOf(r.select(n))), forms.length - 1)]
  return form.replace(VAR, (_, k) => fill(k === 'count' ? n : vars[k]))
}
// Time of day and a short date with time, in the language of the texts.
export const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString(lang(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '')
export const stamp = (iso) => (iso ? new Date(iso).toLocaleString(lang(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')

// ── icons: a 16-unit grid, stroke in the current color ──────────────────────────────────────────────────────────
const sv = (d) => `<svg class="i16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
export const IC = {
  jira: sv('<rect x="2" y="2.5" width="12" height="11" rx="2"/><path d="M6 2.5v11M10 2.5v11M3.7 5.2h.6M7.7 5.2h.6M7.7 7.6h.6M11.7 5.2h.6"/>'),
  ok: sv('<path d="M3.4 8.4l3 3 6.2-6.6"/>'),
  err: sv('<path d="M8 2.3 14.3 13.2H1.7z"/><path d="M8 6.6v3.1M8 11.4v.1"/>'),
  q: sv('<circle cx="8" cy="8" r="5.6"/><path d="M8 5v3.2l2.1 1.3"/>'),
  info: sv('<circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.7M8 5v.1"/>'),
  lock: sv('<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  link: sv('<path d="M6.5 9.5l3-3"/><path d="M7 4.6l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.4l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1"/>'),
  new: sv('<path d="M7.5 2.2l1.3 3.4 3.4 1.3-3.4 1.3-1.3 3.4-1.3-3.4L2.8 6.9l3.4-1.3z"/><path d="M12.6 10.6v3.4M10.9 12.3h3.4"/>'),
}
export const SPIN = '<span class="spin" aria-hidden="true"></span>'

// ── toasts: a stack in the bottom right corner, they go out by themselves ───────────────────────────────────────
const TOAST_MS = 3600
const TOAST_MAX = 3
export function toast(msg) {
  const box = $('.toasts')
  if (!box || !msg) return
  const el = document.createElement('div')
  el.className = 'tst'
  el.textContent = msg
  box.append(el)
  while (box.children.length > TOAST_MAX) box.firstElementChild.remove()
  void el.offsetWidth
  el.classList.add('show')
  setTimeout(() => {
    el.classList.remove('show')
    setTimeout(() => el.remove(), 250)
  }, TOAST_MS)
}

// ── tooltips: one layer for every [data-tip] ───────────────────────────────────────────────────────────────────
const hideTip = () => {
  const tip = $('.tip')
  if (tip) tip.hidden = true
}
document.addEventListener('mouseover', (e) => {
  const tip = $('.tip')
  const el = e.target.closest?.('[data-tip]')
  if (!tip) return
  if (!el?.dataset.tip) return hideTip()
  tip.textContent = el.dataset.tip
  tip.hidden = false
  const r = el.getBoundingClientRect()
  const w = tip.getBoundingClientRect()
  let y = r.top - w.height - 8
  if (y < 4) y = r.bottom + 8
  tip.style.left = `${Math.max(4, Math.min(innerWidth - w.width - 4, r.left + r.width / 2 - w.width / 2))}px`
  tip.style.top = `${y}px`
})
document.addEventListener('scroll', hideTip, { passive: true, capture: true })

// ── render: markup into an element; the element in focus stays in focus, with its caret and selection — an answer of
// Jira or an event of the sync in the middle of typing does not break the input ──────────────────────────────────
// The same element in the new markup: its tag and data-* attributes (a tooltip changes, it is not part of it); a
// radio or a checkbox — with its name and value.
function sameAs(el) {
  const box = /^(checkbox|radio)$/.test(el.type || '')
  const attrs = [...el.attributes].filter((a) => (a.name.startsWith('data-') && a.name !== 'data-tip') || (box && (a.name === 'name' || a.name === 'value')))
  return attrs.length ? el.tagName.toLowerCase() + attrs.map((a) => `[${a.name}="${CSS.escape(a.value)}"]`).join('') : null
}
export function render(root, html) {
  const a = document.activeElement
  const key = a && a !== document.body && root.contains(a) ? sameAs(a) : null
  let range = null
  try {
    if (key && typeof a.selectionStart === 'number') range = [a.selectionStart, a.selectionEnd, a.selectionDirection]
  } catch {
    range = null
  }
  hideTip()
  root.innerHTML = html
  const again = key && root.querySelector(key)
  if (!again) return
  again.focus({ preventScroll: true })
  if (range) {
    try {
      again.setSelectionRange(...range)
    } catch {
      // not a text field
    }
  }
}

// Enter in a field presses the [data-enter] button of its block (the nearest one up the tree), unless it is off.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing || !e.target.matches?.('input:not([type=checkbox]):not([type=radio])')) return
  for (let p = e.target.parentElement; p && p !== document.body; p = p.parentElement) {
    const b = p.querySelector('[data-enter]')
    if (!b) continue
    e.preventDefault()
    if (!b.disabled) b.click()
    return
  }
})

// ── the event stream of the service: onEvent('jira', fn) — fn(data) for every event of that name ─────────────────
let stream = null
const handlers = new Map()
export function onEvent(name, fn) {
  stream ??= new EventSource('api/events')
  if (!handlers.has(name)) {
    handlers.set(name, [])
    stream.addEventListener(name, (e) => {
      let data = null
      try {
        data = JSON.parse(e.data)
      } catch {
        data = null
      }
      for (const f of handlers.get(name)) f(data)
    })
  }
  handlers.get(name).push(fn)
}
