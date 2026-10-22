// One local server playing two roles:
//  - OTLP/HTTP JSON collector on POST /v1/traces, keeping every span it receives
//  - the target the action calls, recording the traceparent header of each request
import http from 'node:http'
import { gunzipSync } from 'node:zlib'

export async function startFakeBackend({ port = 0, onChange } = {}) {
  const spans = []
  const requests = []
  const exports = [] // every request to /v1/traces, accepted or not

  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (req.url.startsWith('/v1/')) {
        const attempt = { method: req.method, path: req.url, contentType: req.headers['content-type'] ?? null }
        exports.push(attempt)
        try {
          let body = Buffer.concat(chunks)
          if (req.headers['content-encoding'] === 'gzip') body = gunzipSync(body)
          if (req.method !== 'POST' || req.url !== '/v1/traces' || !String(attempt.contentType).includes('json')) {
            attempt.status = 415
          } else {
            collect(JSON.parse(body.toString('utf8')), spans)
            attempt.status = 200
          }
        } catch (err) {
          attempt.status = 400
          attempt.error = err.message
        }
        onChange?.()
        res.writeHead(attempt.status, { 'content-type': 'application/json' }).end('{}')
        return
      }

      requests.push({ path: req.url, traceparent: req.headers.traceparent ?? null })
      onChange?.()
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
    })
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    spans,
    requests,
    exports,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}

function collect(payload, spans) {
  for (const resourceSpans of payload.resourceSpans ?? []) {
    const resource = attributes(resourceSpans.resource?.attributes)
    for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
      for (const span of scopeSpans.spans ?? []) {
        spans.push({
          name: span.name,
          kind: span.kind, // OTLP enum: 3 = CLIENT
          traceId: span.traceId,
          spanId: span.spanId,
          scope: scopeSpans.scope?.name,
          attributes: attributes(span.attributes),
          resource,
        })
      }
    }
  }
}

function attributes(list = []) {
  return Object.fromEntries(
    list.map(({ key, value = {} }) => [
      key,
      value.stringValue ?? value.intValue ?? value.boolValue ?? value.doubleValue ?? value,
    ]),
  )
}
