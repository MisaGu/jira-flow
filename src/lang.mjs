// Labels and texts for display only. Code and results carry values (codes); what a person reads is looked up here:
// locales/<lang>.json of the module, then locales/en.json, then the key itself. A locale file is
// { "enum": { "<enum>": { "<value>": "label" } }, "text": { "<key>": "text with {{var}}" } }.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fail } from './errors.mjs'

export const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/
const DIR = fileURLToPath(new URL('../locales/', import.meta.url))
const cache = new Map()

// The language code as the locale file names it: "ru-RU" → "ru" when only the base language exists.
function fileOf(lang) {
  const code = String(lang || 'en')
  for (const c of [code, code.split('-')[0]]) if (fs.existsSync(`${DIR}${c}.json`)) return c
  return null
}

function dict(lang) {
  const code = fileOf(lang)
  if (!code) return null
  if (!cache.has(code)) cache.set(code, JSON.parse(fs.readFileSync(`${DIR}${code}.json`, 'utf8')))
  return cache.get(code)
}

export function checkLang(lang) {
  if (lang !== undefined && (typeof lang !== 'string' || !LANG_RE.test(lang))) fail('INPUT', `lang must be a BCP 47 code, got ${JSON.stringify(lang)}`)
  return lang || 'en'
}

export function labelOf(name, value, lang = 'en') {
  return dict(lang)?.enum?.[name]?.[value] ?? dict('en')?.enum?.[name]?.[value] ?? String(value)
}

// Text by key with {{var}} filled in; an array becomes a comma-separated list.
export function textOf(key, lang = 'en', vars = {}) {
  const raw = dict(lang)?.text?.[key] ?? dict('en')?.text?.[key] ?? key
  return raw.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k]
    return Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v)
  })
}

// Everything a host shows for one language; missing — no locale file for it, English labels came instead.
export function labels(lang = 'en') {
  checkLang(lang)
  const en = dict('en') || {}
  const own = dict(lang) || {}
  const merge = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, { ...a[k], ...b[k] }]))
  return { lang, missing: !fileOf(lang), enum: merge(en.enum, own.enum), text: { ...en.text, ...own.text } }
}
