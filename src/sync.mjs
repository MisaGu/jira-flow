// Keeps issues in step with the host's items. An item is { id, summary, body, status, notes, parent }: id — the host's
// stable key; status — the template status the issue should be in now; notes — [{ id, text }], things that happened,
// each written once as a comment; parent — optional key of the issue to put this one under (an epic). The host keeps
// links through a store ({ get(id), put(id, patch) }) and decides which items to push. The engine creates the issue (or
// finds its own by label: created, but the link was lost), moves it along the template, comments on new notes, puts it
// under the parent and reports what it did through onEvent. Notes present when the issue is created count as seen: the
// body tells that state. A parent is set when the issue is created and again whenever the host names another one; an
// item without a parent leaves the issue's parent alone. A parent Jira refuses does not stop the issue: it is created
// without one, and the parent step reports the error each time until the host names a parent Jira takes. Every step is
// saved as soon as it is done, so a step that fails does not repeat the ones before it. One item at a time; network
// trouble, Jira overload and rate limits retry later.
import crypto from 'node:crypto'
import { enums } from './enums.mjs'
import { fail, retryable } from './errors.mjs'
import { addComment, createIssue, findByLabel, ISSUE_KEY_RE, moveTo, parentRefused, setParent, setText } from './issues.mjs'

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
    if (item.parent && !ISSUE_KEY_RE.test(item.parent)) fail('INPUT', `item ${item.id}: parent must be an issue key like KEY-12, got ${JSON.stringify(item.parent)}`)
    latest.set(item.id, { ...item, parent: item.parent || null, notes: Array.isArray(item.notes) ? item.notes : [] })
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
        store.put(id, { seen: [...seen] })
        emit({ type: E.COMMENTED, id, key: link.key, note: n.id })
      }
      let applied = link.applied ?? null
      if (applied !== item.status) {
        const r = await moveTo(jira, link.key, item.status, template)
        applied = item.status
        store.put(id, { applied })
        emit({ type: E.MOVED, id, key: link.key, from: r.from, to: r.to, path: r.path })
      }
      // an issue of the space's former Jira project keeps its place: an epic of the new project is not its parent
      if (item.parent && (!link.project || link.project === key) && (link.parent ?? null) !== item.parent) {
        await setParent(jira, link.key, item.parent)
        store.put(id, { parent: item.parent })
        emit({ type: E.PARENT, id, key: link.key, parent: item.parent })
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
    const make = (parent) => createIssue(jira, { project: key, type, summary: item.summary, body: item.body || '', labels: [prefix, tag], parent })
    let issue = found
    let parent = found ? found.parent : item.parent
    if (!issue) {
      try {
        issue = await make(item.parent)
      } catch (e) {
        // Jira refused the parent, not the issue: the issue goes in without it; the parent step says why.
        if (!item.parent || !parentRefused(e)) throw e
        issue = await make(null)
        parent = null
      }
    }
    emit({ type: E.CREATED, id: item.id, key: issue.key, found: Boolean(found) })
    return store.put(item.id, { ...link, key: issue.key, project: key, label: tag, applied: found ? null : template.initial, seen: item.notes.map((n) => n.id), parent, error: null })
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
