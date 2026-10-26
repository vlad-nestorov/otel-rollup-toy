// otel-sdk-init (option 2: build-time code transformer)
//
// Starts OpenTelemetry tracing for a Node app or GitHub action without patching any
// module and without loader hooks. Instrumented libraries are rewritten at build time
// by @apm-js-collab/code-transformer (configs in transforms.js) to publish
// diagnostics_channel events; this package subscribes to them. node:http is covered by
// Node's own http channels and fetch by undici's. So the whole SDK can be bundled, and
// start() only has to run before the app makes its first call, not before it loads.

import { context, diag, DiagLogLevel, logs, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { instrumentDataloader, instrumentHttpClient } from './channels.js'
import { captureActionsLogs, serviceNameFrom, stderrDiagLogger } from './actions.js'

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
 * @param {string} [options.serviceName] Used when neither the serviceNameInput action
 *   input nor OTEL_SERVICE_NAME is set.
 * @param {string} [options.serviceNameInput] Action input that sets service.name at
 *   runtime. Defaults to "otel-service-name".
 * @param {boolean} [options.actionsLogs] Export what the action logs through
 *   @actions/core as log records. Defaults to true.
 * @param {string[]} [options.instrumentations] Any of "http", "undici", "dataloader".
 *   Defaults to all.
 */
export function start({
  serviceName = 'unknown_service',
  serviceNameInput = 'otel-service-name',
  actionsLogs = true,
  instrumentations = Object.keys(INSTRUMENTATIONS),
} = {}) {
  if (started) return started

  for (const name of instrumentations) {
    if (!INSTRUMENTATIONS[name]) throw new Error(`[otel] unknown instrumentation "${name}"`)
  }

  // OTEL_LOG_LEVEL (or the debug flag) turns on OTel's own diagnostic logging.
  const logLevel = (process.env.OTEL_LOG_LEVEL || (process.env.OTEL_ROLLUP_DEBUG ? 'info' : '')).toUpperCase()
  if (logLevel && DiagLogLevel[logLevel] !== undefined) {
    // To stderr: whatever goes to stdout is captured as the action's own logs.
    diag.setLogger(stderrDiagLogger, DiagLogLevel[logLevel])
  }

  const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\/+$/, '')
  const service = serviceNameFrom({ serviceName, serviceNameInput })
  const resource = resourceFromAttributes({ 'service.name': service })
  const provider = new TracerProvider({
    resource,
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

  // Logs: what the action writes through @actions/core, as OTel log records.
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter({ url: process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT || `${endpoint}/v1/logs` }),
      }),
    ],
  })
  logs.setGlobalLoggerProvider(loggerProvider)
  const logCapture = actionsLogs ? captureActionsLogs(loggerProvider.getLogger('@actions/core')) : undefined

  for (const name of instrumentations) INSTRUMENTATIONS[name]()

  // Flush when the event loop drains. An action's run() is often not awaited, so the
  // caller can't simply wrap it.
  const shutdown = () => {
    logCapture?.stop()
    return Promise.all([provider.shutdown(), loggerProvider.shutdown()]).then(() => {})
  }
  process.once('beforeExit', () => {
    shutdown().catch((err) => console.error('[otel] failed to flush telemetry:', err))
  })

  if (process.env.OTEL_ROLLUP_DEBUG) {
    // In GitHub Actions, post the line as a notice annotation so it shows on the run page.
    const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::notice title=otel::' : ''
    console.error(`${prefix}[otel] hooks=none node=${process.versions.node} endpoint=${endpoint} service=${service}`)
  }

  started = { provider, loggerProvider, shutdown }
  return started
}
