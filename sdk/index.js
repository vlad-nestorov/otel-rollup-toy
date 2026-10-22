// otel-sdk-init (option 2: build-time code transformer)
//
// Starts OpenTelemetry tracing for a Node app or GitHub action without patching any
// module and without loader hooks. Instrumented libraries are rewritten at build time
// by @apm-js-collab/code-transformer (configs in transforms.js) to publish
// diagnostics_channel events; this package subscribes to them. node:http is covered by
// Node's own http channels and fetch by undici's. So the whole SDK can be bundled, and
// start() only has to run before the app makes its first call, not before it loads.

import { context, diag, DiagConsoleLogger, DiagLogLevel, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { instrumentDataloader, instrumentHttpClient } from './channels.js'

const INSTRUMENTATIONS = {
  // Node's built-in http.client.* channels.
  http: () => instrumentHttpClient(),
  // undici publishes its own channels; the stock OTel instrumentation subscribes to them.
  undici: () => registerInstrumentations({ instrumentations: [new UndiciInstrumentation()] }),
  // Channels injected into dataloader at build time (see transforms.js).
  dataloader: () => instrumentDataloader(),
}

let started

/**
 * Starts the SDK and subscribes the instrumentations. Call it before the app makes
 * its first instrumented call.
 *
 * @param {object} [options]
 * @param {string} [options.serviceName] Used when OTEL_SERVICE_NAME isn't set.
 * @param {string[]} [options.instrumentations] Any of "http", "undici", "dataloader".
 *   Defaults to all.
 */
export function start({ serviceName = 'unknown_service', instrumentations = Object.keys(INSTRUMENTATIONS) } = {}) {
  if (started) return started

  for (const name of instrumentations) {
    if (!INSTRUMENTATIONS[name]) throw new Error(`[otel] unknown instrumentation "${name}"`)
  }

  // OTEL_LOG_LEVEL (or the debug flag) turns on OTel's own diagnostic logging.
  const logLevel = (process.env.OTEL_LOG_LEVEL || (process.env.OTEL_ROLLUP_DEBUG ? 'info' : '')).toUpperCase()
  if (logLevel && DiagLogLevel[logLevel] !== undefined) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[logLevel])
  }

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '')
  const provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || serviceName }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || `${endpoint}/v1/traces`,
        }),
      }),
    ],
  })
  trace.setGlobalTracerProvider(provider)
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())
  propagation.setGlobalPropagator(
    new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  )

  for (const name of instrumentations) INSTRUMENTATIONS[name]()

  // Flush when the event loop drains. An action's run() is often not awaited, so the
  // caller can't simply wrap it.
  process.once('beforeExit', () => {
    provider.shutdown().catch((err) => console.error('[otel] failed to flush spans:', err))
  })

  if (process.env.OTEL_ROLLUP_DEBUG) {
    // In GitHub Actions, post the line as a notice annotation so it shows on the run page.
    const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::notice title=otel::' : ''
    console.error(`${prefix}[otel] hooks=none node=${process.versions.node} endpoint=${endpoint}`)
  }

  started = { provider, shutdown: () => provider.shutdown() }
  return started
}
