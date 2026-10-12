# jira-flow — session rules

- Read `README.md` first: what lives where, the contract, the host, the sync.
- jira-flow is a service — an engine, its server with a page, a JSON contract — not a claude-module module: no core,
  no model. A host runs the engine in its own process or talks to the server; either way it only calls the engine and
  never reaches Jira itself.
- English only in code, comments, messages, README and schemas. Other languages only in `locales/<lang>.json` and
  `tests/fixtures/`. Keys, statuses and codes are enum values (`src/enums.mjs`) with a label in `locales/en.json`;
  a text a person reads — a key in `locales/` (`textOf`), the page's texts — `page.*` keys.
- The service knows no host: no product names, folders or formats of a host anywhere — run
  `JIRA_FLOW_FORBID=<words> npm test` with the words of the hosts you know.
- Nothing personal in the repository: no site names, emails, account ids or people of a real Jira; tests use
  `example.atlassian.net`, `KEY` and made-up ids.
- The token goes only into the Authorization header and the host's secret store (`localHost`: `secrets.json`, mode
  600) — never into results, events, logs or the page.
- Jira is written only when a person asks (apply, a new project) or the sync of a space is on. Live checks on a real
  Jira only with the owner's consent.
- A change of the contract (`contract/calls.schema.json`, `events.schema.json`: routes, bodies, results, events) —
  `CONTRACT` in `index.mjs` and `version` in `package.json` go up together; the routes of `src/server.mjs` and the
  table of the contract stay equal (a test checks).
- `npm test` before every commit. No AI in commits or pull requests: no co-author trailers, no "Generated with".
- Changes go through pull requests; tags and pushes only when the owner asks.
