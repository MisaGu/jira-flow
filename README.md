# jira-flow

Workflow templates for Jira Cloud team-managed projects, and issues kept in step with the host's items.

- **Template.** A workflow as data: statuses with categories, transitions, the status a new issue starts in, board
  columns, issue types and roles. The bundled `design-dev` template runs design first (Design → Design Review → Design
  Approved) and then development (To Do → To Do (Approved) → In Progress → AI Testing → Human Testing → Done; Done only
  after Human Testing).
- **Check, plan, apply.** `inspect` compares a project with the template item by item and says how each item can be
  fixed. `applyTemplate` brings a team-managed Jira Software project in line in one go: missing board columns,
  then statuses, transitions and role rules through the workflow API, then the column order. A dry run lets Jira
  validate without writing. In a project with issues only what moves no issue goes in (transitions, role rules, the
  initial status, the column order); new statuses, other categories and new columns need an empty project.
- **Roles.** Who leads an issue in which statuses and who may move it into a gate status become Jira transition rules:
  an assignee on entering a status, a restriction on entering a gate. One person in Jira holds every role.
- **New project.** `createFromTemplate` creates an empty team-managed project and applies the template (Jira admins
  only).
- **Sync.** `createSync` keeps one issue per host item: creates it (or finds its own by label), moves it along the
  template to the status the host asks for, comments on new notes once, puts it under the parent issue the host names
  (an epic), rewrites its text on request, retries network trouble.

The module knows nothing about its caller: the host passes the connection, the template, saved roles, the items and a
store for links, and shows texts in its language through `labels(lang)`.

## Where things are

| Path | What |
|---|---|
| `main.mjs` | the command line: `check`, `apply`, `people`, `projects`, `create`, `template`, `labels`, `help` |
| `index.mjs` | the library entry: exactly what `module.json` → `api` names |
| `module.json` | passport: name, version, contract, api, commands, schemas |
| `src/client.mjs` | REST client: Basic auth with an API token, the site first and the Atlassian gateway after 401/403, cloudId of a site |
| `src/template.mjs` | template loading and validation, roles and transition rules, `describeTemplate` |
| `src/check.mjs` | the project check (codes and variables), the plan, `describe` |
| `src/project.mjs` | the project as it is: workflows, statuses, board, people, admin right, list, a new project |
| `src/workflow.mjs` | the workflow update request, Jira validation, applying with the Jira task |
| `src/board.mjs` | board columns through the GraphQL gateway: read, create, order |
| `src/apply.mjs` | `inspect`, `applyTemplate`, `createFromTemplate` |
| `src/issues.mjs` | issues: own by label, create, read, path and move, comment, text, parent |
| `src/sync.mjs` | the sync engine |
| `src/adf.mjs` | markdown → ADF for descriptions and comments |
| `src/enums.mjs`, `src/lang.mjs`, `src/errors.mjs` | enums with labels, locales lookup, the error type |
| `contract/` | JSON schemas: connection, template, check, sync item |
| `locales/` | labels and texts: `en.json` (every value), `ru.json` |
| `templates/` | bundled templates: `design-dev.json` |
| `tests/` | `npm test` — no network, no Jira |

## Running

```
npm test
node main.mjs help
node main.mjs check --project KEY --lang en --site NAME.atlassian.net --email ADDRESS --token-file PATH
node main.mjs apply --project KEY --dry-run
node main.mjs create --key KEY --name "Project name"
```

The connection comes from flags or `JIRA_FLOW_SITE`, `JIRA_FLOW_EMAIL`, `JIRA_FLOW_TOKEN_FILE`. The token is read from
a file, never from a flag. `--roles FILE` passes saved roles (`{ "<role>": { "people": [accountId], "assign":
accountId | null } }`).

## Events and exit codes

The command line prints a JSON result on stdout. An error is `{ "error": { "code", "message" } }` on stderr; codes
are `enums.code` (`INPUT`, `NO_LOGIN`, `AUTH`, `NOT_FOUND`, `JIRA`, `NETWORK`, `TIMEOUT`, `NOT_TEAM_MANAGED`,
`NOT_EMPTY`, `EXISTS`, `NO_PATH`, `NO_TRANSITION`, `TASK_FAILED`, `COLUMNS`).

| Exit code | When |
|---|---|
| 0 | done |
| 1 | failed (Jira, network, a project that cannot take the template) |
| 2 | usage: wrong command, flag or input |

The sync engine reports to `onEvent`: `{ type: 'created', id, key, found }`, `{ type: 'moved', id, key, from, to,
path }`, `{ type: 'commented', id, key, note }`, `{ type: 'parent', id, key, parent }`, `{ type: 'text', id, key }`,
`{ type: 'error', id, code, message, retry }`.

## Isolation: who guarantees what

- **The module:** the token goes only into the Authorization header — not into results, errors or events; nothing is
  read from or written to disk; Jira is written only by `applyTemplate` (not in a dry run), `createFromTemplate`,
  `createProject`, the sync engine and the issue functions it is made of (`createIssue`, `moveTo`, `addComment`,
  `setText`, `setParent`); new statuses, categories and columns go only into an empty project.
- **Jira:** validates every workflow update before it is applied; transition rules apply to people moving issues by
  hand as well.
- **The host:** keeps the token and the saved roles, decides which items to sync and when, keeps the links (the store),
  shows texts in its language.

## From code

```js
import { createClient, loadTemplate, inspect, applyTemplate, describe, createSync, labels } from 'jira-flow'

const jira = createClient({ site, email, token })
const template = loadTemplate('design-dev')

const state = await inspect(jira, 'KEY', { template, roles: savedRoles })
show(describe(state, 'ru'))                 // titles and texts for a language
await applyTemplate(jira, 'KEY', { template, roles: savedRoles, dryRun: true })

const sync = createSync({ client: () => jira, project: 'KEY', template, store, scope: spaceId, prefix: 'myhost', onEvent })
sync.push({ id: 'item-1', summary: 'Header redesign', body: '## Short\n…', status: 'Design Review', notes: [{ id: 'ready:v1', text: 'v1 is ready' }], parent: 'KEY-7' })

const epic = await readIssue(jira, 'KEY-7')  // { key, summary, status, type, level, project, parent }; level 1 — an epic

labels('ru')                               // every label and text in Russian; a missing language falls back to English
```

A store is `{ get(id) → link | null, put(id, patch) → link }`; the engine keeps `key`, `project`, `label`, `applied`,
`seen`, `parent` and `error` in a link, the host may keep its own fields next to them. Each step is saved as soon as it
is done: a step that fails (a transition Jira does not offer, a parent it refuses) does not repeat a comment written
before it. Check results carry codes and variables
(`code`, `vars`); `describe(result, lang)` adds `title` and `text`. A new language comes as `locales/<lang>.json`.

## Parent issue

An item may name a parent: the key of the issue to put its issue under, usually an epic (`KEY-7`, see `ISSUE_KEY_RE`).

- A new issue is created under the parent in the same request (`fields.parent = { key }`).
- An issue made earlier without a parent, or under another one, gets the item's parent on the next push: the link keeps
  the parent the engine set last, and the engine writes it again only when the host names another one.
- An item without a parent leaves the issue's parent as it is: the engine never takes an issue out of an epic.
- A parent Jira refuses (gone, not visible to the login, not one level up, another project) does not stop the issue: it
  is created without a parent, status and notes keep up, and every push reports the refusal as an `error` event until
  the host names a parent Jira takes.
- `readIssue` lets the host check a key before it uses it: the issue's project, type and the type's `level` in the
  hierarchy (1 — an epic, 0 — a standard issue, -1 — a subtask).

## Development

- Everything in English: code, comments, messages, README, schemas. Other languages only in `locales/` and test
  fixtures. Every key, status and code is an enum value with a label in `locales/en.json`.
- No dependencies: Node 22 and its `fetch`.
- `npm test` must pass before a commit. `JIRA_FLOW_FORBID=word1,word2 npm test` also checks that no caller is named.
- Commits and pull requests name no AI: no co-author trailers, no "Generated with".
