// Every key, status and code the module tells apart — as enums (rule K4); labels only for display (K5).
// In code: enums.state.OK, enums.code.AUTH; label: enums.state.label('ok', lang).
import { labelOf } from './lang.mjs'

const keyOf = (v) => v.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
function makeEnum(name, values) {
  return Object.freeze({ ...Object.fromEntries(values.map((v) => [keyOf(v), v])), values: Object.freeze([...values]), label: (v, lang) => labelOf(name, v, lang) })
}

export const enums = Object.freeze({
  // Errors: code from here, message in English.
  code: makeEnum('code', ['INPUT', 'NO_LOGIN', 'AUTH', 'NOT_FOUND', 'JIRA', 'NETWORK', 'TIMEOUT', 'NOT_TEAM_MANAGED', 'NOT_EMPTY', 'EXISTS', 'NO_PATH', 'NO_TRANSITION', 'TASK_FAILED', 'COLUMNS']),
  // Jira status categories.
  category: makeEnum('category', ['new', 'indeterminate', 'done']),
  phase: makeEnum('phase', ['design', 'dev']),
  // Project check against a template: what each item is about and how it stands.
  item: makeEnum('item', ['kind', 'statuses', 'categories', 'transitions', 'initial', 'board', 'types', 'issues', 'rules']),
  state: makeEnum('state', ['ok', 'warn', 'bad', 'unknown']),
  // Who can bring an item in line: the module itself (api), only a person in Jira (manual), unknown without a login (check).
  via: makeEnum('via', ['api', 'manual', 'check']),
  role: makeEnum('role', ['design', 'lead', 'dev', 'qa']),
  // What the sync engine reports to its host.
  event: makeEnum('event', ['created', 'moved', 'commented', 'parent', 'text', 'error']),
  // What moveIssue did with an issue the space did not create, and why it left one alone.
  move: makeEnum('move', ['moved', 'kept', 'skipped']),
  skip: makeEnum('skip', ['sync_off', 'project', 'own', 'status']),
})
