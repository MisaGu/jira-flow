// The module's own rules: English outside locales and fixtures (rule K1), every enum value labelled in English and in
// every other locale (K5), lang checked (K2), no word of a caller anywhere (A1), api = what module.json names,
// one version in module.json and package.json, every .mjs starts with a comment.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, check, done } from './harness.mjs'
import * as api from '../index.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKIP = new Set(['.git', 'node_modules', 'runs'])
function files(dir = ROOT) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (SKIP.has(d.name) ? [] : d.isDirectory() ? files(path.join(dir, d.name)) : [path.join(dir, d.name)]))
}
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
const text = (f) => fs.readFileSync(f, 'utf8')
// Other languages are allowed only in data: locales and test fixtures.
const FOREIGN_OK = /^(locales\/|tests\/fixtures\/)/
// Words of callers this module must not know — from JIRA_FLOW_FORBID (comma-separated), so the module names none.
const WORDS = String(process.env.JIRA_FLOW_FORBID || '').split(',').map((w) => w.trim()).filter(Boolean)
const CALLER = new RegExp(`(?<![\\p{L}\\p{N}_])(${WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'iu')
const CYR = /\p{Script=Cyrillic}/u

await check('K1: no letters outside the Latin script in code, docs and schemas', () => {
  const bad = files().filter((f) => !FOREIGN_OK.test(rel(f)) && /\.(mjs|json|md)$/.test(f) && /(?=\p{L})\P{Script=Latin}/u.test(text(f)))
  assert.deepEqual(bad.map(rel), [])
})

await check('A1: no word of a caller in any file or file name', () => {
  if (!WORDS.length) return
  const bad = files().filter((f) => CALLER.test(rel(f)) || CALLER.test(text(f)))
  assert.deepEqual(bad.map(rel), [])
})

await check('K5: every enum value has an English label, and every other locale covers every value and text', () => {
  const en = JSON.parse(text(path.join(ROOT, 'locales/en.json')))
  for (const [name, e] of Object.entries(api.enums)) for (const v of e.values) assert.ok(en.enum?.[name]?.[v], `en: ${name}.${v}`)
  for (const f of fs.readdirSync(path.join(ROOT, 'locales')).filter((n) => n !== 'en.json')) {
    const loc = JSON.parse(text(path.join(ROOT, 'locales', f)))
    for (const [name, e] of Object.entries(api.enums)) for (const v of e.values) assert.ok(loc.enum?.[name]?.[v], `${f}: ${name}.${v}`)
    for (const k of Object.keys(en.text)) assert.ok(loc.text?.[k], `${f}: text ${k}`)
  }
})

await check('K2: lang — a BCP 47 code, en by default; labels of a language without a file come in English, missing', () => {
  assert.equal(api.checkLang(undefined), 'en')
  assert.equal(api.checkLang('ru-RU'), 'ru-RU')
  assert.throws(() => api.checkLang('en_US'), (e) => e.code === 'INPUT')
  const de = api.labels('de')
  assert.equal(de.missing, true)
  assert.equal(de.enum.state.ok, 'matches')
  assert.match(api.labels('ru').enum.state.ok, CYR)
  assert.equal(api.enums.code.label('AUTH', 'ru-RU'), api.labels('ru').enum.code.AUTH)
  assert.equal(api.textOf('check.statuses.missing', 'en', { names: ['A', 'B'] }), 'Missing: A, B.')
})

await check('api: exports are exactly module.json api; one version; every .mjs starts with a comment', () => {
  const passport = JSON.parse(text(path.join(ROOT, 'module.json')))
  const pkg = JSON.parse(text(path.join(ROOT, 'package.json')))
  assert.deepEqual(Object.keys(api).sort(), [...passport.api].sort())
  assert.equal(passport.version, pkg.version)
  assert.equal(api.VERSION, pkg.version)
  for (const f of files().filter((x) => x.endsWith('.mjs'))) assert.match(text(f).replace(/^#!.*\n/, ''), /^\/\/ /, rel(f))
})

done('rules')
