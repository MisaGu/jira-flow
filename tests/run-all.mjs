// npm test: every tests/*.test.mjs in its own process; no network, no Jira.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('.', import.meta.url))
let failed = 0
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.test.mjs')).sort()) {
  const r = spawnSync(process.execPath, [`${dir}${f}`], { stdio: 'inherit' })
  if (r.status !== 0) failed++
}
process.exit(failed ? 1 : 0)
