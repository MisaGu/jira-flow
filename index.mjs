// jira-flow for code: everything named in module.json → api, nothing else.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { applyTemplate, blockedFor, createFromTemplate, inspect } from './src/apply.mjs'
import { arrangeColumns, boardOps, planColumns, readColumns, wantedOrder } from './src/board.mjs'
import { checkProject, describe, planFor, rulesItem } from './src/check.mjs'
import { boardUrl, createClient, issueUrl, siteCloudId, SITE_RE } from './src/client.mjs'
import { enums } from './src/enums.mjs'
import { FlowError, retryable } from './src/errors.mjs'
import { addComment, createIssue, findByLabel, ISSUE_KEY_RE, moveTo, pathTo, readIssue, setParent, setText, statusOf } from './src/issues.mjs'
import { checkLang, labels, textOf } from './src/lang.mjs'
import { createProject, isAdmin, KEY_RE, listProjects, readPeople, readProject } from './src/project.mjs'
import { createSync } from './src/sync.mjs'
import { describeTemplate, loadTemplate, roleOf, rolesFor, rulesFor, TEMPLATE_IDS, validateTemplate } from './src/template.mjs'
import { buildUpdate } from './src/workflow.mjs'
import { markdownToAdf } from './src/adf.mjs'

const passport = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./module.json', import.meta.url)), 'utf8'))
export const VERSION = passport.version
export const CONTRACT = passport.contract
const schemaOf = (name) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`./contract/${name}.schema.json`, import.meta.url)), 'utf8'))
export const schemas = Object.freeze(Object.fromEntries(Object.keys(passport.schemas).map((k) => [k, schemaOf(k)])))

export {
  addComment,
  applyTemplate,
  arrangeColumns,
  blockedFor,
  boardOps,
  boardUrl,
  buildUpdate,
  checkLang,
  checkProject,
  createClient,
  createFromTemplate,
  createIssue,
  createProject,
  createSync,
  describe,
  describeTemplate,
  enums,
  findByLabel,
  FlowError,
  inspect,
  isAdmin,
  issueUrl,
  ISSUE_KEY_RE,
  KEY_RE,
  labels,
  listProjects,
  loadTemplate,
  markdownToAdf,
  moveTo,
  pathTo,
  planColumns,
  planFor,
  readColumns,
  readIssue,
  readPeople,
  readProject,
  retryable,
  roleOf,
  rolesFor,
  rulesFor,
  rulesItem,
  setParent,
  setText,
  siteCloudId,
  SITE_RE,
  statusOf,
  TEMPLATE_IDS,
  textOf,
  validateTemplate,
  wantedOrder,
}
