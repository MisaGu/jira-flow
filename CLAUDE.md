# jira-flow — session rules

- Read `README.md` first: what lives where, the api, the sync engine.
- English only in code, comments, messages, README and schemas. Other languages only in `locales/<lang>.json` and
  `tests/fixtures/`. Keys, statuses and codes are enum values (`src/enums.mjs`) with a label in `locales/en.json`;
  results carry codes and variables, never phrases for people.
- The module knows no caller: no product names, folders or formats of a host anywhere — run
  `JIRA_FLOW_FORBID=<words> npm test` with the words of the hosts you know.
- Nothing personal in the repository: no site names, emails, account ids or people of a real Jira; tests use
  `example.atlassian.net`, `KEY` and made-up ids.
- The module reads and writes no files; the host passes the connection and a store.
- Jira is written only by `applyTemplate`, `createFromTemplate`, `createProject` and the sync engine. Live checks on a
  real Jira only with the owner's consent.
- A change of what a function returns or takes: bump `contract` and `version` in `module.json` and `package.json`
  together.
- `npm test` before every commit. No AI in commits or pull requests: no co-author trailers, no "Generated with".
- Tags and pushes only when the owner asks.
