// Keeps issues in step with the host's items. An item is { id, summary, body, status, notes }: id — the host's stable
// key; status — the template status the issue should be in now; notes — [{ id, text }], things that happened, each
// written once as a comment. The host keeps links through a store ({ get(id), put(id, patch) }) and decides which
// items to push. The engine creates the issue (or finds its own by label: created, but the link was lost), moves it
// along the template, comments on new notes and reports what it did through onEvent. Notes present when the issue is
// created count as seen: the body tells that state. One item at a time; network trouble, Jira overload and rate
// limits retry later.
import crypto from 'node:crypto'
import { enums } from './enums.mjs'
import { fail, retryable } from './errors.mjs'
import { addComment, createIssue, findByLabel, moveTo, setText } from './issues.mjs'

const RETRY_MS = [30000, 120000, 600000]
const E = enums.event

// client — () => Jira client or null (no login yet); project — key or () => key; scope — makes labels unique per host
// space (two hosts with the same item ids get different labels); prefix — the first label of every issue.
export function createSync({ client, project, template, store, scope = '', prefix = 'flow', type = 'Task', onEvent = () => {}, retryMs = RETRY_MS }) {
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(prefix)) fail('INPUT', `prefix must be a short lowercase label, got ${JSON.stringify(prefix)}`)
  const statuses = new Set(template.statuses.map((s) => s.name))
  const label = (id) => `${prefix}-${crypto.createHash('sha1').update(`${scope}\n${id}`).digest('hex').slice(0, 12)}`
  const keyOf = () => (typeof project === 'function' ? project() : project)
  const latest = new Map()
  const timers = new Map()
  const tries = new Map()
  let chain = Promise.resolve()
  let closed = false
  const emit = (e) => {
    try {
      onEvent(e)
    } catch {
      // a host's handler must not stop the queue
    }
  }
  const run = (task) => (chain = chain.then(task).catch(() => {}))

  function schedule(id, ms) {
    if (closed) return
    clearTimeout(timers.get(id))
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id)
        run(() => reconcile(id))
      }, ms),
    )
  }

  // The latest state of an item wins: pushed twice before the queue got to it — written once.
  function push(item, delay = 0) {
    if (!item || typeof item.id !== 'string' || !item.id) fail('INPUT', 'item.id must be a non-empty string')
    if (!item.summary) fail('INPUT', `item ${item.id}: summary is required`)
    if (!statuses.has(item.status)) fail('INPUT', `item ${item.id}: status ${JSON.stringify(item.status)} is not in template ${template.id}`)
    latest.set(item.id, { ...item, notes: Array.isArray(item.notes) ? item.notes : [] })
    schedule(item.id, delay)
  }

  async function reconcile(id) {
    const item = latest.get(id)
    if (!item || closed) return
    latest.delete(id)
    const jira = client()
    const key = keyOf()
    try {
      if (!jira) fail('NO_LOGIN', 'no Jira login')
      if (!key) fail('INPUT', 'no Jira project')
      let link = store.get(id) || {}
      if (!link.key) link = await create(jira, key, item, link)
      const seen = [...(link.seen || [])]
      for (const n of item.notes) {
        if (seen.includes(n.id)) continue
        await addComment(jira, link.key, n.text)
        seen.push(n.id)
        emit({ type: E.COMMENTED, id, key: link.key, note: n.id })
      }
      let applied = link.applied ?? null
      if (applied !== item.status) {
        const r = await moveTo(jira, link.key, item.status, template)
        applied = item.status
        emit({ type: E.MOVED, id, key: link.key, from: r.from, to: r.to, path: r.path })
      }
      store.put(id, { applied, seen, error: null })
      tries.delete(id)
    } catch (e) {
      const again = retryable(e) && (tries.get(id) || 0) < retryMs.length
      store.put(id, { error: { code: e.code || 'JIRA', message: e.message } })
      emit({ type: E.ERROR, id, code: e.code || 'JIRA', message: e.message, retry: again })
      if (again) {
        const n = tries.get(id) || 0
        tries.set(id, n + 1)
        if (!latest.has(id)) latest.set(id, item)
        schedule(id, retryMs[n])
      }
    }
  }

  async function create(jira, key, item, link) {
    const tag = label(item.id)
    const found = await findByLabel(jira, key, tag)
    const issue = found || (await createIssue(jira, { project: key, type, summary: item.summary, body: item.body || '', labels: [prefix, tag] }))
    emit({ type: E.CREATED, id: item.id, key: issue.key, found: Boolean(found) })
    return store.put(item.id, { ...link, key: issue.key, project: key, label: tag, applied: found ? null : template.initial, seen: item.notes.map((n) => n.id), error: null })
  }

  // The host has a new summary and body for an item (a full description written later): the same issue gets them.
  function rewrite(id, { summary, body }) {
    return new Promise((done) =>
      run(async () => {
        const link = store.get(id)
        const jira = client()
        try {
          if (!link?.key) fail('NOT_FOUND', `item ${id} has no issue yet`)
          if (!jira) fail('NO_LOGIN', 'no Jira login')
          await setText(jira, link.key, { summary, body })
          store.put(id, { error: null })
          emit({ type: E.TEXT, id, key: link.key })
          done(true)
        } catch (e) {
          store.put(id, { error: { code: e.code || 'JIRA', message: e.message } })
          emit({ type: E.ERROR, id, code: e.code || 'JIRA', message: e.message, retry: false })
          done(false)
        }
      }),
    )
  }

  return {
    push,
    rewrite,
    label,
    // Run what is waiting now and wait for the queue — for tests and shutdown.
    idle: async () => {
      for (const [id, t] of timers) {
        clearTimeout(t)
        timers.delete(id)
        run(() => reconcile(id))
      }
      await chain
    },
    close() {
      closed = true
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}
