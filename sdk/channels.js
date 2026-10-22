// HTTP client spans built only on Node's diagnostics channels: nothing is patched and no
// loader hooks are needed, so it works the same whether or not the code is bundled.
import dc from 'node:diagnostics_channel'
import { context, propagation, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { isTracingSuppressed } from '@opentelemetry/core'

// HTTP client spans from Node's built-in http channels.
export function instrumentHttpClient() {
  const tracer = trace.getTracer('otel-sdk-init/http')
  const spans = new WeakMap()

  // Published inside http.request() before the request is sent, so headers can still be set.
  dc.subscribe('http.client.request.created', ({ request }) => {
    // The OTLP exporter's own requests run with tracing suppressed.
    if (isTracingSuppressed(context.active())) return
    const span = tracer.startSpan(request.method, {
      kind: SpanKind.CLIENT,
      attributes: {
        'http.request.method': request.method,
        'url.full': `${request.protocol}//${request.getHeader('host') ?? request.host}${request.path}`,
      },
    })
    spans.set(request, span)
    propagation.inject(trace.setSpan(context.active(), span), request, {
      set: (req, key, value) => req.setHeader(key, value),
    })
  })

  dc.subscribe('http.client.response.finish', ({ request, response }) => {
    const span = spans.get(request)
    if (!span) return
    spans.delete(request)
    span.setAttribute('http.response.status_code', response.statusCode)
    if (response.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
    span.end()
  })

  dc.subscribe('http.client.request.error', ({ request, error }) => {
    const span = spans.get(request)
    if (!span) return
    spans.delete(request)
    span.recordException(error)
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
    span.end()
  })
}
