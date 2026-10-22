// Checks the state file written by serve-fake-backend.mjs after the toy action ran.
// Usage: node check-backend.mjs <state-file>
import { readFileSync } from 'node:fs'
import { checkSpans, createChecker } from './checks.mjs'

const state = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const { check, failures } = createChecker()

console.log('What the fake backend received from the action run by the GitHub runner')
checkSpans(state, check)

console.log(failures() === 0 ? '\nAll checks passed.' : `\n${failures()} check(s) failed.`)
process.exitCode = failures() === 0 ? 0 : 1
