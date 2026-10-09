// Columns of a team-managed board — through the site's GraphQL gateway (/gateway/api/graphql): there is no public REST
// for them (JRACLOUD-94779). createColumn and rankColumn are in Atlassian's public schema and allowed to API tokens.
// In a team-managed project a new column creates its own status of the same name, so columns go in BEFORE the
// workflow update, which then finds those statuses by name and only fixes their category and transitions. A status
// that already exists without a column is left to a person: a column would create a second status of that name.
import { FlowError } from './errors.mjs'
import { norm } from './template.mjs'

const Q_COLUMNS = 'query JiraFlowBoardColumns($id: ID!) { boardScope(boardId: $id) { board { columns { id name columnStatus { status { id name } } } } } }'
const M_CREATE = 'mutation JiraFlowCreateColumn($input: CreateColumnInput) { createColumn(input: $input) { success statusCode message newColumn { id name } } }'
const M_RANK = 'mutation JiraFlowRankColumn($input: RankColumnInput) { rankColumn(input: $input) { success statusCode message } }'

async function gql(jira, operationName, query, variables) {
  const r = await jira.post('/gateway/api/graphql', { operationName, query, variables })
  if (r?.errors?.length) throw new FlowError('COLUMNS', `Jira GraphQL ${operationName}: ${r.errors.map((e) => e.message).join('; ')}`)
  return r?.data
}
function must(op, res) {
  if (!res?.success) throw new FlowError('COLUMNS', `Jira ${op}: ${res?.message || res?.statusCode || 'no answer'}`)
  return res
}

// Sources write the board ARI two ways — the one the columns are read with wins.
const aris = (cloudId, id) => [`ari:cloud:jira-software:${cloudId}:board/${id}`, `ari:cloud:jira:${cloudId}:board/${id}`]

export async function readColumns(jira, boardId) {
  const cloudId = await jira.cloudId()
  let last = null
  for (const ari of aris(cloudId, boardId)) {
    try {
      const cols = (await gql(jira, 'JiraFlowBoardColumns', Q_COLUMNS, { id: ari }))?.boardScope?.board?.columns
      if (cols) return { ari, columns: cols.map((c) => ({ id: String(c.id), name: c.name, statuses: [c.columnStatus].flat().filter(Boolean).map((s) => s.status?.name).filter(Boolean) })) }
    } catch (e) {
      last = e
    }
  }
  throw last || new FlowError('COLUMNS', 'board columns could not be read')
}

// Template columns the board lacks: create — no status of that name yet, the column brings it; manual — the status
// exists without a column, a person adds that column.
export function planColumns(columns, tpl, statusNames) {
  const have = new Set(columns.map((c) => norm(c.name)))
  const missing = tpl.columns.filter((n) => !have.has(norm(n)))
  const known = new Set([...statusNames].map(norm))
  return { create: missing.filter((n) => !known.has(norm(n))), manual: missing.filter((n) => known.has(norm(n))) }
}

// Column order by the template: template columns in its order, others after them as they stood. rankColumn moves one
// column at a time; whether Jira counts positions from 0 or 1 the schema does not say — the order is read after each
// move, and if a column landed elsewhere, a second pass shifts by one.
export function wantedOrder(columns, tpl) {
  const rank = new Map(tpl.columns.map((n, i) => [norm(n), i]))
  const ours = columns.filter((c) => rank.has(norm(c.name))).sort((a, b) => rank.get(norm(a.name)) - rank.get(norm(b.name)))
  return [...ours, ...columns.filter((c) => !rank.has(norm(c.name)))]
}
const sameOrder = (a, b) => a.length === b.length && a.every((c, i) => c.id === b[i].id)

export async function arrangeColumns(ops, tpl) {
  for (const base of [0, 1]) {
    let cols = await ops.read()
    for (let i = 0; i < cols.length; i++) {
      const want = wantedOrder(cols, tpl)
      if (sameOrder(cols, want)) return { ordered: true, columns: cols }
      if (cols[i].id === want[i].id) continue
      await ops.rank(want[i].id, i + base)
      cols = await ops.read()
      if (cols[i]?.id !== want[i].id) break
    }
    cols = await ops.read()
    if (sameOrder(cols, wantedOrder(cols, tpl))) return { ordered: true, columns: cols }
  }
  return { ordered: false, columns: await ops.read() }
}

// Read, create and rank columns of the board by the ARI it was read with (readColumns).
export function boardOps(jira, ari) {
  return {
    read: async () => ((await gql(jira, 'JiraFlowBoardColumns', Q_COLUMNS, { id: ari }))?.boardScope?.board?.columns || []).map((c) => ({ id: String(c.id), name: c.name })),
    create: async (name) => must('createColumn', (await gql(jira, 'JiraFlowCreateColumn', M_CREATE, { input: { boardId: ari, columnName: name } }))?.createColumn).newColumn,
    rank: async (columnId, position) => must('rankColumn', (await gql(jira, 'JiraFlowRankColumn', M_RANK, { input: { boardId: ari, columnId, position } }))?.rankColumn),
  }
}
