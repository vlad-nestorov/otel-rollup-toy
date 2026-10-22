// Runtime instrumentations built only on diagnostics channels: nothing is patched and no
// loader hooks are needed, so they work the same whether or not the code is bundled.
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

// Runtime half of the dataloader instrumentation: the build-time transform in
// transforms.js wraps DataLoader#load in this tracing channel.
export function instrumentDataloader() {
  const tracer = trace.getTracer('otel-sdk-init/dataloader')

  dc.tracingChannel('orchestrion:dataloader:load').subscribe({
    start(message) {
      const loaderName = message.self?.name
      message.span = tracer.startSpan(loaderName ? `dataloader.load ${loaderName}` : 'dataloader.load', {
        kind: SpanKind.CLIENT,
      })
    },
    error(message) {
      message.span?.recordException(message.error)
      message.span?.setStatus({ code: SpanStatusCode.ERROR, message: message.error?.message })
    },
    // A synchronous throw ends here; a returned promise ends in asyncEnd.
    end(message) {
      if (message.error) message.span?.end()
    },
    asyncEnd(message) {
      message.span?.end()
    },
  })
}
