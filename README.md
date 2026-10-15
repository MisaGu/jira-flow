# jira-flow

A service for Jira Cloud: workflow templates for team-managed projects, and issues kept in step with a host's items.
One engine does all the Jira work; a host runs it in its own process (`createFlow`) or talks to the service's own
server (`serve`), which also has a page for a person. Calls and events are a JSON contract (`contract/`).

- **Template.** A workflow as data: statuses with categories, transitions, the status a new issue starts in, board
  columns, issue types and roles. The bundled `design-dev` template runs design first (Design → Design Review → Design
  Approved) and then development (To Do → To Do (Approved) → In Progress → AI Testing → Human Testing → Done; Done only
  after Human Testing).
- **Check, plan, apply.** The engine compares a project with the template item by item and says how each item can be
  fixed; apply brings a team-managed Jira Software project in line in one go: missing board columns, then statuses,
  transitions and role rules through the workflow API, then the column order. A dry run lets Jira validate without
  writing. In a project with issues only what moves no issue goes in (transitions, role rules, the initial status, the
  column order); new statuses, other categories and new columns need an empty project.
- **Roles.** Who leads an issue in which statuses and who may move it into a gate status become Jira transition rules:
  an assignee on entering a status, a restriction on entering a gate. One person in Jira holds every role.
- **New project.** An empty team-managed project with the template applied (Jira admins only).
- **A space and its sync.** A space is a host's project whose items become issues: its Jira project, epics for its
  issues (the space's, each group's, an item's own) and a sync switch. With the sync on, every item has one issue:
  created (or found by its own label), moved along the template to the status the host gives, commented on new notes
  once, put under its epic, its text rewritten on request; network trouble is retried.

## Where things are

| Path | What |
|---|---|
| `index.mjs` | the library entry: the service, its contract and what a host shows — nothing else |
| `main.mjs` | the command line: `serve` (the service and its page), `check`, `apply`, `people`, `projects`, `create`, `template`, `labels`, `help` |
| `src/engine.mjs` | the engine (`createFlow`): login, projects, template work, roles, a space — its project, epics, sync and feed |
| `src/hosts.mjs` | `localHost`: the service's own data in one folder |
| `src/server.mjs` | the server: the page, one route per call of the contract (`ROUTES`), the event stream |
| `src/schema.mjs` | JSON Schema checks of bodies and results against `contract/` |
| `src/client.mjs` | REST client: Basic auth with an API token, the site first and the Atlassian gateway after 401/403, cloudId of a site |
| `src/template.mjs` | template loading and validation, roles and transition rules, texts of the template |
| `src/check.mjs` | the project check (codes and variables), the plan, texts of a check |
| `src/project.mjs` | the project as it is: workflows, statuses, board, people, admin right, list, a new project |
| `src/workflow.mjs` | the workflow update request, Jira validation, applying with the Jira task |
| `src/board.mjs` | board columns through the GraphQL gateway: read, create, order |
| `src/apply.mjs` | inspect, apply, a new project from the template |
| `src/issues.mjs` | issues: own by label, create, read, path and move, comment, text, parent |
| `src/sync.mjs` | the sync queue: one item at a time, the latest state wins, retries |
| `src/adf.mjs` | markdown → ADF for descriptions and comments |
| `src/enums.mjs`, `src/lang.mjs`, `src/errors.mjs` | enums with labels, locales lookup, the error type |
| `contract/` | JSON schemas: `calls` (routes, bodies, results), `events`, and connection, template, check, item |
| `locales/` | labels and texts: `en.json` (every value), `ru.json`; `page.*` — texts of the page |
| `templates/` | bundled templates: `design-dev.json` |
| `web/` | the page of the service |
| `tests/` | `npm test` — no network, no Jira |

## Running

```
npm test
node main.mjs serve                # http://127.0.0.1:47393/ — data in ~/.jira-flow (--home DIR, JIRA_FLOW_HOME)
node main.mjs help
node main.mjs check --project KEY --lang en --site NAME.atlassian.net --email ADDRESS --token-file PATH
```

The terminal commands other than `serve` take the connection from flags or `JIRA_FLOW_SITE`, `JIRA_FLOW_EMAIL`,
`JIRA_FLOW_TOKEN_FILE`; the token is read from a file, never from a flag. They print JSON on stdout; an error is
`{ "error": { "code", "message" } }` on stderr. Exit codes: 0 — done, 1 — failed, 2 — usage.

## The contract

Every call answers an envelope `{ ok: true, result }` or `{ ok: false, error, code }`: `error` — the text for a person in
the service's language, `code` — `enums.code` (`INPUT`, `NO_LOGIN`, `AUTH`, `NOT_FOUND`, `JIRA`, `NETWORK`, `TIMEOUT`,
`NOT_TEAM_MANAGED`, `NOT_EMPTY`, `EXISTS`, `NO_PATH`, `NO_TRANSITION`, `TASK_FAILED`, `COLUMNS`). The same calls are
engine methods and HTTP routes; bodies and results are definitions of `contract/calls.schema.json`.

| Route | Engine | Body | Result |
|---|---|---|---|
| `GET /api/flow` | `overview()` | — | `overview` |
| `GET /api/flow/labels` | `labels()` | — | `labels` |
| `POST /api/flow/login` | `login({ site, email, token })` | `login` | `overview` |
| `POST /api/flow/logout` | `logout()` | `empty` | `overview` |
| `GET /api/flow/check` | `check({ project })` | `?project=` | `check` |
| `POST /api/flow/apply` | `apply({ project, dryRun })` | `apply` | `applied` |
| `POST /api/flow/create` | `create({ key, name })` | `create` | `applied` |
| `GET /api/flow/roles` | `roles({ project })` | `?project=` | `roles` |
| `POST /api/flow/roles` | `saveRoles({ project, roles })` | `saveRoles` | `roles` |
| `GET /api/space` | `state()` | — | `state` |
| `POST /api/space/link` | `setLink({ project })` | `project` | `state` |
| `GET /api/space/epic` | `epic()` | — | `epic` |
| `GET /api/space/epics` | `epics()` | — | `epicMap` |
| `POST /api/space/epic` | `setEpic({ epic, group, id, inherit })` | `setEpic` | `epicSet` |
| `GET /api/space/sync` | `sync()` | — | `sync` |
| `POST /api/space/sync` | `setSync({ on, ids })` | `setSync` | `sync` |
| `POST /api/space/add` | `add({ id })` | `add` | `sync` |
| `GET /api/space/feed` | `feed()` | — | `feed` |
| `POST /api/space/items` | `host.space.put(items), then changed(ids)` | `items` | `itemsPut` |
| `POST /api/space/move` | `moveIssue({ key, from, steps, comment })` | `moveIssue` | `issueMoved` |

Events — `GET api/events` (Server-Sent Events) and `emit(event, data)` of the engine; `contract/events.schema.json`:
`jira` — `{ type: 'created', id, key, found }`, `{ type: 'moved', id, key, from, to, path }`, `{ type: 'commented', id,
key, note }`, `{ type: 'parent', id, key, parent }`, `{ type: 'text', id, key }`, `{ type: 'error', id, code, message,
retry }`.

## The host

The engine knows its host only through one object: where the login, the saved roles and a space live.

```js
host = {
  name,
  account: { get() → { site, email, token, source? } | null, save({ site, email, token }), forget(), view?() → {} },
  roles:   { get(site, key) → { <role>: { people, assign } }, save(site, key, roles) },
  space?:  { id,
             link:  { get(site) → { project, epic?, epics? } | null, set(site, { project, epic?, epics? }) },
             sync:  { get() → { on, since }, set(patch) },
             links: { get(site, id), put(site, id, patch) → link, all(site) → { <id>: link } },
             items(id?) → [{ id, summary, body?, status, notes?, group?, firstAt?, at?, view? }],
             groups?() → [{ id, title }] },
}
```

`localHost({ home })` keeps it all in one folder: `login.json` (site, email), `secrets.json` (tokens by site, mode
600; Windows has no modes — there the file is as private as its folder), `roles.json`, `space.json` (the Jira project
and epics by site, the sync switch), `links.json` (item ↔ issue by site) and `items.json` (items a client put through
`POST api/space/items`). A host of another program passes its own object: its login store, its project as the space,
its items with `view` — what it shows of an item, which the feed gives back as is. A link keeps `key`, `project`,
`label`, `applied`, `seen`, `parent` and `error`; the host may keep its own fields next to them.

## From code

```js
import { createFlow, localHost, serve, labels } from 'jira-flow'

// In the host's process: the host's own data, events to its page.
const flow = createFlow({ host, emit: (event, data) => toPage(event, data), lang: 'ru' })
await flow.check({ project: 'KEY' })            // items, plan, what applying would do, roles — with texts in lang
flow.setLink({ project: 'KEY' })
await flow.setEpic({ epic: 'KEY-7' })          // checked in Jira: in the project, one level above a task
await flow.setEpic({ epic: 'KEY-8', group: 'g1' })  // the epic of a group; { id } — an item's own
await flow.epics()                             // the project's epics to pick from, every group with its choice
flow.setSync({ on: true, ids: ['item-1'] })    // these existing items go at once, new ones by themselves
flow.changed(['item-2'])                       // the host's item changed: its issue follows once the change settles
await flow.moveIssue({ key: 'KEY-31', from: ['In Progress', 'AI Testing'], steps: ['AI Testing', 'Human Testing'], comment: '## Tests passed' })
                                               // an issue the space did not create follows the host's decision
flow.said(error)                               // what to show a person for an error

// Or the service on its own, with its page:
const s = await serve({ host: localHost({ home }), lang: 'en' })   // s.url, s.close()
```

## Parent issue

An issue goes under the epic of its item: the item's own, else its group's, else the space's.

- A group is the host's way to sort its items (a section, a screen): an item names its `group`, the host may list
  every group with `groups()` — those without items too, so their epics can be chosen ahead. Without `groups()` the
  groups are the ones the items name.
- The choices live in the space's link: `epic` — the space's; `epics.groups` and `epics.items` — `{ <id>: key | null }`.
  An entry is that level's choice, `null` — no epic (the level above is not asked); no entry — the level above
  decides. `setEpic({ epic, group })` and `setEpic({ epic, id })` set one, an empty `epic` — no epic, `inherit: true`
  drops the entry. Another Jira project drops every choice; the same one keeps them.
- `epics()` reads the project's epics from Jira (the types one level above a task, whatever their name) and gives
  every level at once: the space's epic, each group with its own choice and the epic its items get, the items' own
  choices and the chosen keys Jira no longer has as epics of the project.
- A new issue is created under its epic in the same request (`fields.parent = { key }`).
- An issue made earlier without a parent, or under another one, gets its epic on the next sync step: the link keeps
  the parent written last, and the engine writes it again only when the item's epic changes. A choice set with the
  sync on sends the items it touches through the sync at once: a group's — its items, an item's — that item, the
  space's — every item; an issue whose epic did not change is not written.
- No epic leaves an issue's parent as it is: the engine never takes an issue out of an epic. A person who moves an
  issue to another epic in Jira keeps it there until the item's epic changes in the host.
- An epic Jira refuses (gone, not visible to the login, not one level up, another project) does not stop the issue: it
  is created without a parent, status and notes keep up, and every step reports the refusal as an `error` event until
  the epic is fixed. `epic()` says what is wrong with the epic now.

## An issue the space did not create

A space syncs its own items. A host may also have to move an issue it did not create — a task a person filed and works
on — after a decision of its own about it (a test report accepted or sent back). `moveIssue({ key, from, steps, comment
})` does it in one call:

- the issue must be in the Jira project of the space and the sync of the space must be on — otherwise nothing is
  written and the result says why (`reason`: `project`, `sync_off`);
- its status is read first, and the steps are taken only while it stands in one of `from` — the host names the statuses
  its decision may move an issue out of; an issue a person finished, or one still in design, is left alone
  (`reason: status`);
- the comment goes first, then the steps in order, each along its path in the template; steps up to the issue's own
  status are skipped, so a repeated decision only comments (`state: kept`);
- events — `commented` and `moved` with `id` = the issue key.

## Isolation: who guarantees what

- **The service:** the token goes only into the Authorization header and the host's secret store — never into results,
  errors, events or the page; Jira is written only when a person asks (apply, a new project) or the sync of a space is
  on (its items and `moveIssue`); new statuses, categories and columns go only into an empty project. The server
  listens on 127.0.0.1, answers only to its own Host (a page that rebinds its name to this machine gets nothing), takes
  a POST only with the header `x-flow: 1` and checks every body against the contract.
- **Jira:** validates every workflow update before it is applied; transition rules apply to people moving issues by
  hand as well.
- **The host:** keeps the login and the saved roles, decides which items to sync and when, keeps the links, shows texts
  in its language.

## Development

- Everything in English: code, comments, messages, README, schemas. Other languages only in `locales/` and test
  fixtures. Every key, status and code is an enum value with a label in `locales/en.json`.
- No dependencies: Node 22 and its `fetch`.
- `npm test` must pass before a commit. `JIRA_FLOW_FORBID=word1,word2 npm test` also checks that no host is named.
- A change of the contract: `CONTRACT` (index.mjs) and `version` (package.json) go up together.
- Commits and pull requests name no AI: no co-author trailers, no "Generated with".
