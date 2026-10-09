// Shared by the test files: check() collects results, done() prints the total and sets the exit code. A line "✗ …"
// is a failure.
import assert from 'node:assert/strict'

const results = []
export async function check(name, fn) {
  try {
    await fn()
    results.push(true)
  } catch (e) {
    results.push(false)
    console.log(`✗ ${name}: ${e.message.split('\n')[0]}`)
  }
}
export function done(suite) {
  const ok = results.filter(Boolean).length
  console.log(`${suite}: ${ok} of ${results.length} passed`)
  if (ok !== results.length) process.exitCode = 1
}
export { assert }
