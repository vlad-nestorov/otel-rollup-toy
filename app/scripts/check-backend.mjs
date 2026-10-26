// Checks the state file written by serve-fake-backend.mjs after the toy action ran.
// Usage: node check-backend.mjs <state-file> [expected service.name] [api-token the action got]
import { readFileSync } from 'node:fs'
import { checkLogs, checkSpans, createChecker } from './checks.mjs'

const [stateFile, serviceName = 'toy-action', token] = process.argv.slice(2)
const state = JSON.parse(readFileSync(stateFile, 'utf8'))
const { check, failures } = createChecker()

console.log('What the fake backend received from the action run by the GitHub runner')
checkSpans(state, check, serviceName)
checkLogs(state, check, { serviceName, token })

console.log(failures() === 0 ? '\nAll checks passed.' : `\n${failures()} check(s) failed.`)
process.exitCode = failures() === 0 ? 0 : 1
