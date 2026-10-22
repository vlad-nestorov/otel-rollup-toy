// Runs the fake backend as a standalone process (for CI), writing everything it has
// received to a JSON file after each request.
// Usage: node serve-fake-backend.mjs <port> <state-file>
import { writeFileSync } from 'node:fs'
import { startFakeBackend } from './fake-backend.mjs'

const [port = '4318', stateFile] = process.argv.slice(2)
if (!stateFile) throw new Error('usage: serve-fake-backend.mjs <port> <state-file>')

const backend = await startFakeBackend({
  port: Number(port),
  onChange: () =>
    writeFileSync(stateFile, JSON.stringify({ spans: backend.spans, requests: backend.requests }, null, 2)),
})
writeFileSync(stateFile, JSON.stringify({ spans: [], requests: [] }))
console.log(`fake backend listening on ${backend.url}`)
