// JSON Schema — the part the contract uses: type, enum, const, pattern, lengths, bounds, required, properties,
// additionalProperties, items, $ref (#/$defs/… of the same file or <name>.schema.json of contract/), anyOf, oneOf.
// Enough to check the bodies the service takes and the results it gives against contract/*.schema.json, with no
// dependency. validate(value, schema) → a list of problems, [] — fits.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const DIR = fileURLToPath(new URL('../contract/', import.meta.url))
const cache = new Map()

// A contract schema by name: schema('calls') — contract/calls.schema.json.
export function schema(name) {
  if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(`${DIR}${name}.schema.json`, 'utf8')))
  return cache.get(name)
}

const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v)
const fits = (t, v) => t === kind(v) || (t === 'number' && kind(v) === 'integer')
const pointer = (doc, frag) => (frag ? frag.replace(/^\//, '').split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc) : doc)

function walk(v, s, root, at, out) {
  if (s === true || s === undefined) return
  if (s === false) return out.push(`${at || '/'}: nothing is allowed here`)
  if (s.$ref) {
    const [file, frag = ''] = s.$ref.split('#')
    const doc = file ? schema(file.replace(/\.schema\.json$/, '')) : root
    const target = pointer(doc, frag)
    if (target === undefined) return out.push(`${at || '/'}: no schema at ${s.$ref}`)
    walk(v, target, doc, at, out)
  }
  if (s.type !== undefined && ![].concat(s.type).some((t) => fits(t, v))) return out.push(`${at || '/'}: ${kind(v)}, not ${[].concat(s.type).join(' | ')}`)
  if (s.const !== undefined && JSON.stringify(v) !== JSON.stringify(s.const)) out.push(`${at || '/'}: not ${JSON.stringify(s.const)}`)
  if (s.enum && !s.enum.some((x) => JSON.stringify(x) === JSON.stringify(v))) out.push(`${at || '/'}: ${JSON.stringify(v)} is not one of ${s.enum.map((x) => JSON.stringify(x)).join(', ')}`)
  if (typeof v === 'string') {
    if (s.minLength !== undefined && [...v].length < s.minLength) out.push(`${at || '/'}: shorter than ${s.minLength}`)
    if (s.maxLength !== undefined && [...v].length > s.maxLength) out.push(`${at || '/'}: longer than ${s.maxLength}`)
    if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) out.push(`${at || '/'}: does not match ${s.pattern}`)
  }
  if (typeof v === 'number') {
    if (s.minimum !== undefined && v < s.minimum) out.push(`${at || '/'}: below ${s.minimum}`)
    if (s.maximum !== undefined && v > s.maximum) out.push(`${at || '/'}: above ${s.maximum}`)
  }
  if (Array.isArray(v)) {
    if (s.minItems !== undefined && v.length < s.minItems) out.push(`${at || '/'}: fewer than ${s.minItems} items`)
    if (s.maxItems !== undefined && v.length > s.maxItems) out.push(`${at || '/'}: more than ${s.maxItems} items`)
    if (s.items) v.forEach((x, i) => walk(x, s.items, root, `${at}/${i}`, out))
  }
  if (kind(v) === 'object') {
    for (const k of s.required || []) if (!(k in v)) out.push(`${at || '/'}: ${k} is required`)
    for (const [k, x] of Object.entries(v)) {
      if (s.properties && k in s.properties) walk(x, s.properties[k], root, `${at}/${k}`, out)
      else if (s.additionalProperties === false) out.push(`${at}/${k}: not in the schema`)
      else if (typeof s.additionalProperties === 'object') walk(x, s.additionalProperties, root, `${at}/${k}`, out)
    }
  }
  if (s.anyOf && !s.anyOf.some((x) => !validate(v, x, root, at).length)) out.push(`${at || '/'}: fits none of anyOf`)
  if (s.oneOf && s.oneOf.filter((x) => !validate(v, x, root, at).length).length !== 1) out.push(`${at || '/'}: fits not exactly one of oneOf`)
}

export function validate(value, s, root = s, at = '') {
  const out = []
  walk(value, s, root, at, out)
  return out
}

// A value against a definition of a contract file: validateRef(body, 'calls', 'login') — #/$defs/login of calls.
export const validateRef = (value, name, def) => validate(value, { $ref: `${name}.schema.json#/$defs/${def}` }, schema(name))
