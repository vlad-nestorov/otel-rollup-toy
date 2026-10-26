// Assertions shared by verify.mjs (local runs) and check-backend.mjs (the CI job that
// runs the built action through the GitHub runner).
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import path from 'node:path'

const SPAN_KIND_CLIENT = 3

// Non-builtin modules the built files in `dir` still load with require() at runtime:
// plain `require("x")` or a call through a createRequire shim such as rolldown's
// `__require("x")`. A deployed action has no node_modules, so each of these would throw
// "Cannot find module" there. `supports-color` is the `debug` package's optional
// require inside try/catch, which is meant to fail quietly.
export async function runtimeRequiresIn(dir, { optional = ['supports-color'] } = {}) {
  const found = new Set()
  const call = /(?<![\w$.])(?:require|__require\w*)\(\s*["']([^"'.][^"']*)["']\s*\)/g
  for (const file of await readdir(dir, { recursive: true })) {
    if (!/\.m?js$/.test(file)) continue
    // Drop comments so documentation examples don't count.
    const code = (await readFile(path.join(dir, file), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    for (const [, specifier] of code.matchAll(call)) {
      const builtin = specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])
      if (!builtin && !optional.includes(specifier)) found.add(specifier)
    }
  }
  return [...found]
}
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

export function createChecker() {
  let failures = 0
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`)
    if (!ok) failures++
  }
  return { check, failures: () => failures }
}

// What an instrumented run of the toy action must have produced at the fake backend.
export function checkSpans({ spans, requests, exports = [] }, check, serviceName = 'toy-action') {
  console.log(`      export requests received: ${exports.length}`)
  for (const e of exports) {
    console.log(`        ${e.method} ${e.path}  ${e.contentType}  -> ${e.status}${e.error ? `  (${e.error})` : ''}`)
  }
  const byPath = (p) =>
    spans.find((s) => s.kind === SPAN_KIND_CLIENT && JSON.stringify(s.attributes).includes(p))
  const viaHttp = byPath('/via-http')
  const viaFetch = byPath('/via-fetch')

  check('http.get exported a CLIENT span', Boolean(viaHttp), viaHttp?.scope ?? `${spans.length} spans received`)
  check('fetch exported a CLIENT span', Boolean(viaFetch), viaFetch?.scope ?? `${spans.length} spans received`)
  checkPropagation('http.get', viaHttp, requests, '/via-http', check)
  checkPropagation('fetch', viaFetch, requests, '/via-fetch', check)
  check(
    `spans carry service.name=${serviceName}`,
    spans.length > 0 && spans.every((s) => s.resource['service.name'] === serviceName),
  )
  for (const s of spans) console.log(`      span: ${s.name}  [${s.scope}]  trace ${s.traceId}`)
}

function checkPropagation(label, span, requests, urlPath, check) {
  const header = requests.find((r) => r.path === urlPath)?.traceparent
  const match = header && TRACEPARENT.exec(header)
  check(
    `${label} sent a traceparent that points at its span`,
    Boolean(span && match && match[1] === span.traceId && match[2] === span.spanId),
    header ?? 'no traceparent header',
  )
}

const SEVERITY_DEBUG = 5
const SEVERITY_INFO = 9

// What an instrumented run must have exported as log records: the action's
// @actions/core output, with the api-token it registered as a secret masked.
export function checkLogs({ logs = [] }, check, { serviceName = 'toy-action', token } = {}) {
  console.log(`      log records received: ${logs.length}`)
  for (const l of logs) {
    console.log(`      log: ${l.severityText ?? l.severityNumber} ${JSON.stringify(l.body)}  [${l.scope}]`)
  }
  const result = logs.find((l) => l.severityNumber === SEVERITY_INFO && String(l.body).startsWith('http.get -> '))
  check('core.info() exported an INFO log record', Boolean(result), result ? '' : `${logs.length} records received`)
  if (token) {
    const auth = logs.find((l) => l.severityNumber === SEVERITY_DEBUG && String(l.body).startsWith('api-token:'))
    check('core.debug() exported a DEBUG log record, secret masked', auth?.body === 'api-token: ***', auth?.body ?? 'none received')
    check('no log record contains the secret', logs.every((l) => !JSON.stringify(l).includes(token)))
  }
  check('workflow commands were parsed, not exported as text', logs.every((l) => !String(l.body).startsWith('::')))
  check(
    `log records carry service.name=${serviceName}`,
    logs.length > 0 && logs.every((l) => l.resource['service.name'] === serviceName),
  )
}
