// Assertions shared by verify.mjs (local runs) and check-backend.mjs (the CI job that
// runs the built action through the GitHub runner).

const SPAN_KIND_CLIENT = 3
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
export function checkSpans({ spans, requests }, check, serviceName = 'toy-action') {
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
