#!/usr/bin/env node
// jira-flow command line: the service with its page (serve) and the template work from a terminal. Connection of the
// terminal commands — flags or JIRA_FLOW_SITE, JIRA_FLOW_EMAIL, JIRA_FLOW_TOKEN_FILE; the token is read from a file,
// never from a flag. Results are JSON on stdout; an error is { "error": { "code", "message" } } on stderr. Exit codes:
// 0 — done, 1 — failed, 2 — usage.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { applyTemplate, createFromTemplate, inspect } from './src/apply.mjs'
import { describe } from './src/check.mjs'
import { createClient } from './src/client.mjs'
import { localHost } from './src/hosts.mjs'
import { checkLang, labels } from './src/lang.mjs'
import { listProjects, readPeople } from './src/project.mjs'
import { PORT, serve } from './src/server.mjs'
import { describeTemplate, loadTemplate } from './src/template.mjs'

const HELP = `jira-flow <command> [flags]

Commands
  serve     [--port N] [--home DIR]  the service and its page on 127.0.0.1 (port ${PORT}); data — DIR (~/.jira-flow)
  check     --project KEY            the project against the template, with the plan
  apply     --project KEY [--dry-run] apply the template (dry run: Jira validates, nothing is written)
  people    --project KEY            people of the project and the login
  projects                           projects the login sees
  create    --key KEY [--name NAME]  a new team-managed project with the template (Jira admin only)
  template                           the template with texts for --lang
  labels                             labels of every enum and text for --lang
  help

Flags
  --site NAME.atlassian.net   --email ADDRESS   --token-file PATH   (or JIRA_FLOW_SITE, JIRA_FLOW_EMAIL, JIRA_FLOW_TOKEN_FILE)
  --template ID (default design-dev)   --roles FILE (saved roles, JSON)   --lang CODE (default en)
`

const EXIT = { OK: 0, FAILED: 1, USAGE: 2 }
const out = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`)
const usage = (why) => {
  process.stderr.write(`${why}\n\n${HELP}`)
  process.exit(EXIT.USAGE)
}

let args
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      site: { type: 'string' },
      email: { type: 'string' },
      'token-file': { type: 'string' },
      project: { type: 'string' },
      key: { type: 'string' },
      name: { type: 'string' },
      template: { type: 'string' },
      roles: { type: 'string' },
      lang: { type: 'string' },
      'dry-run': { type: 'boolean' },
      port: { type: 'string' },
      home: { type: 'string' },
    },
  })
} catch (e) {
  usage(e.message)
}
const { values: f, positionals } = args
const command = positionals[0] || 'help'

function client() {
  const site = f.site || process.env.JIRA_FLOW_SITE
  const email = f.email || process.env.JIRA_FLOW_EMAIL
  const file = f['token-file'] || process.env.JIRA_FLOW_TOKEN_FILE
  if (!site || !email || !file) usage('a connection needs --site, --email and --token-file')
  const token = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim()
  return createClient({ site, email, token })
}
const need = (name) => f[name] || usage(`--${name} is required`)
const savedRoles = () => (f.roles ? JSON.parse(fs.readFileSync(f.roles, 'utf8')) : {})

try {
  const lang = checkLang(f.lang)
  const template = loadTemplate(f.template || 'design-dev')
  if (command === 'help') process.stdout.write(HELP)
  else if (command === 'serve') {
    const port = f.port === undefined ? PORT : Number(f.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) usage('--port must be a port number')
    const home = path.resolve(f.home || process.env.JIRA_FLOW_HOME || path.join(os.homedir(), '.jira-flow'))
    const s = await serve({ port, host: localHost({ home }), lang })
    process.stderr.write(`jira-flow: ${s.url} · data — ${home}\n`)
    const stop = () => s.close().then(() => (process.exitCode = EXIT.OK))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  }
  else if (command === 'labels') out(labels(lang))
  else if (command === 'template') out(describeTemplate(template, lang))
  else if (command === 'projects') out(await listProjects(client()))
  else if (command === 'people') out(await readPeople(client(), need('project')))
  else if (command === 'check') {
    const r = await inspect(client(), need('project'), { template, roles: savedRoles() })
    out(describe({ ...r, people: undefined, raw: undefined }, lang))
  } else if (command === 'apply') out(await applyTemplate(client(), need('project'), { template, roles: savedRoles(), dryRun: Boolean(f['dry-run']), lang }))
  else if (command === 'create') out(await createFromTemplate(client(), { key: need('key'), name: f.name, template, roles: savedRoles(), lang }))
  else usage(`unknown command ${command}`)
} catch (e) {
  process.stderr.write(`${JSON.stringify({ error: { code: e.code || 'JIRA', message: e.message } })}\n`)
  process.exit(e.code === 'INPUT' ? EXIT.USAGE : EXIT.FAILED)
}
