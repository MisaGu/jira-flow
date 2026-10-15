// jira-flow — a service for Jira Cloud: the engine (createFlow), the host of its own data (localHost), its server with
// a page (serve, PORT, ROUTES), the contract (schema, validate) and what a host shows (labels, texts of the template,
// keys and addresses). The Jira work itself — client, template, issues, sync — is inside, behind the engine.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export { createFlow } from './src/engine.mjs'
export { localHost } from './src/hosts.mjs'
export { PORT, ROUTES, serve } from './src/server.mjs'
export { schema, validate, validateRef } from './src/schema.mjs'
export { enums } from './src/enums.mjs'
export { FlowError } from './src/errors.mjs'
export { checkLang, labels, textOf } from './src/lang.mjs'
export { describeTemplate, loadTemplate, TEMPLATE_IDS } from './src/template.mjs'
export { boardUrl, issueUrl, SITE_RE } from './src/client.mjs'
export { KEY_RE } from './src/project.mjs'
export { ISSUE_KEY_RE } from './src/issues.mjs'

const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'))
export const VERSION = pkg.version
// The contract of the service (contract/: calls, events and their shapes). A host compares it with the one it was
// written for and stops with a clear error instead of breaking quietly.
export const CONTRACT = 5
// The service's page: a host with its own shell serves these files itself or copies the page.
export const WEB = new URL('./web/', import.meta.url)
