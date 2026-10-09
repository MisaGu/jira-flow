// Jira Cloud REST client: Basic auth with an API token of the person (email:token). The token goes only into the
// Authorization header — never into results, errors or logs. The site answers first; a token with scopes is refused
// there (401/403), then the Atlassian gateway api.atlassian.com/ex/jira/<cloudId> is tried, as Atlassian documents.
// The module reads nothing from disk: the host passes the site, the email and the token.
import { fail, FlowError } from './errors.mjs'

export const SITE_RE = /^[a-z0-9][a-z0-9-]{0,62}\.(atlassian\.net|jira\.com)$/
const CLOUD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const TIMEOUT_MS = 30000

function netError(e, what) {
  return e?.name === 'TimeoutError' ? new FlowError('TIMEOUT', `${what}: no answer in ${TIMEOUT_MS / 1000} s`) : new FlowError('NETWORK', `${what}: ${e?.cause?.code || e?.message || e}`)
}

// The site tells its cloudId without a login: https://<site>/_edge/tenant_info. Kept for the life of the process;
// a failure is asked again next time.
const cloudIds = new Map()
export function siteCloudId(site, { fetch: f = fetch } = {}) {
  if (!cloudIds.has(site)) {
    const ask = (async () => {
      let res
      try {
        res = await f(`https://${site}/_edge/tenant_info`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } })
      } catch (e) {
        throw netError(e, `site ${site}`)
      }
      const id = res.ok ? (await res.json().catch(() => null))?.cloudId : null
      if (!CLOUD_RE.test(id || '')) fail('NOT_FOUND', `site ${site} did not tell its cloudId (HTTP ${res.status})`)
      return id
    })()
    cloudIds.set(site, ask)
    ask.catch(() => cloudIds.delete(site))
  }
  return cloudIds.get(site)
}

const codeOf = (status) => (status === 401 || status === 403 ? 'AUTH' : status === 404 ? 'NOT_FOUND' : 'JIRA')

// fetch — for tests: a function with the signature of global fetch.
export function createClient({ site, email, token, fetch: f = fetch } = {}) {
  if (!SITE_RE.test(String(site || ''))) fail('INPUT', `site must look like <name>.atlassian.net, got ${JSON.stringify(site)}`)
  if (!email || !token) fail('NO_LOGIN', 'email and API token are required')
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`
  const gateway = async () => {
    try {
      return [`https://api.atlassian.com/ex/jira/${await siteCloudId(site, { fetch: f })}`]
    } catch {
      return []
    }
  }
  let good = null
  async function call(method, route, body) {
    const tried = good ? [good] : [`https://${site}`]
    let last = null
    for (let i = 0; i < tried.length; i++) {
      let res
      try {
        res = await f(tried[i] + route, {
          method,
          redirect: 'manual',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          headers: { authorization: auth, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        })
      } catch (e) {
        throw netError(e, `Jira ${method} ${route}`)
      }
      const text = await res.text()
      let data = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      if (res.ok) {
        good = tried[i]
        return data
      }
      last = { status: res.status, data }
      if (![401, 403].includes(res.status) || good) break
      if (i === 0) tried.push(...(await gateway()))
    }
    const d = last?.data || {}
    const why = [...(d.errorMessages || []), ...Object.entries(d.errors || {}).map(([k, v]) => `${k}: ${v}`), d.message].filter(Boolean).join('; ')
    throw new FlowError(codeOf(last?.status), `Jira ${method} ${route} → ${last?.status}${why ? `: ${why}` : ''}`, { status: last?.status, data: last?.data })
  }
  return {
    site,
    email,
    cloudId: () => siteCloudId(site, { fetch: f }),
    get: (route) => call('GET', route),
    post: (route, body) => call('POST', route, body),
    put: (route, body) => call('PUT', route, body),
  }
}

export const issueUrl = (site, key) => `https://${site}/browse/${key}`
export const boardUrl = (site, key, boardId) => (boardId ? `https://${site}/jira/software/projects/${key}/boards/${boardId}` : `https://${site}/jira/core/projects/${key}/board`)
