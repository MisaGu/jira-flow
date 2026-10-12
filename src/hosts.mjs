// Hosts of the service: where the login, the saved roles and the space live (the host shape — src/engine.mjs).
// localHost keeps everything in one folder, the service's own home:
//   login.json   — the site and the email of the login;
//   secrets.json — API tokens by site, mode 600, never sent anywhere but to Jira;
//   roles.json   — saved roles by site and Jira project;
//   space.json   — the Jira project and epic of the space by site, the sync switch;
//   links.json   — item ↔ issue by site;
//   items.json   — the items a client put through the API (POST api/space/items).
// A host of another program passes its own object of the same shape instead.
import fs from 'node:fs'
import path from 'node:path'
import { fail } from './errors.mjs'

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
// Written whole through a temporary file: a crash leaves the old file, not half of a new one.
function writeJson(file, value, mode = null) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined)
  fs.renameSync(tmp, file)
  if (mode) fs.chmodSync(file, mode)
}

export function localHost({ home, name = 'local' } = {}) {
  if (!home || typeof home !== 'string') fail('INPUT', 'localHost needs home: the folder of the service data')
  const dir = path.resolve(home)
  const at = (f) => path.join(dir, f)
  const obj = (f) => {
    const v = readJson(at(f), {})
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  }
  const tokens = () => obj('secrets.json').tokens || {}
  const saveTokens = (t) => writeJson(at('secrets.json'), { ...obj('secrets.json'), tokens: t }, 0o600)

  const account = {
    get() {
      const l = obj('login.json')
      const token = l.site ? tokens()[l.site] : null
      return l.site && l.email && token ? { site: l.site, email: l.email, token, source: 'local' } : null
    },
    save({ site, email, token }) {
      saveTokens({ ...tokens(), [site]: token })
      writeJson(at('login.json'), { site, email })
    },
    forget() {
      const l = obj('login.json')
      if (l.site) {
        const t = { ...tokens() }
        delete t[l.site]
        saveTokens(t)
      }
      fs.rmSync(at('login.json'), { force: true })
    },
  }

  const roles = {
    get: (site, key) => obj('roles.json')[site]?.[key] || {},
    save(site, key, value) {
      const all = obj('roles.json')
      writeJson(at('roles.json'), { ...all, [site]: { ...all[site], [key]: value } })
    },
  }

  const items = () => {
    const v = readJson(at('items.json'), [])
    return Array.isArray(v) ? v : []
  }
  const space = {
    id: dir,
    link: {
      get: (site) => obj('space.json').link?.[site] || null,
      set(site, value) {
        const s = obj('space.json')
        writeJson(at('space.json'), { ...s, link: { ...s.link, [site]: value } })
      },
    },
    sync: {
      get: () => obj('space.json').sync || { on: false, since: null },
      set(patch) {
        const s = obj('space.json')
        writeJson(at('space.json'), { ...s, sync: { ...s.sync, ...patch } })
      },
    },
    links: {
      get: (site, id) => obj('links.json')[site]?.[id] || null,
      put(site, id, patch) {
        const all = obj('links.json')
        const mine = { ...all[site] }
        mine[id] = { ...mine[id], ...patch, at: new Date().toISOString() }
        writeJson(at('links.json'), { ...all, [site]: mine })
        return mine[id]
      },
      all: (site) => obj('links.json')[site] || {},
    },
    items: (id = null) => (id === null ? items() : items().filter((i) => i.id === id)),
    // Items from a client: new ones are added, known ones replaced; the first time an item is seen — firstAt.
    put(list) {
      const now = new Date().toISOString()
      const all = new Map(items().map((i) => [i.id, i]))
      for (const i of list) all.set(i.id, { ...i, firstAt: i.firstAt || all.get(i.id)?.firstAt || now, at: i.at || now })
      writeJson(at('items.json'), [...all.values()])
      return list.map((i) => i.id)
    },
  }
  return { name, account, roles, space }
}
