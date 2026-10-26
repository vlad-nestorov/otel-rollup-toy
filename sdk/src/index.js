// otel-sdk-init
//
// Starts OpenTelemetry tracing for a Node app or GitHub action, built to be bundled
// with it. No loader hooks: in a bundled app the only modules a loader hook could hand
// to an instrumentation are Node's builtins, and those are shared, mutable objects that
// can be patched in place. So start() runs the stock OTel instrumentations' own patch
// functions on node:http and node:https directly, and fetch is covered by undici's
// diagnostics channels. start() just has to run before the app makes its first call.
//
// The package ships this file prebundled with its OpenTelemetry dependencies as
// dist/index.cjs (see rollup.config.js), so the app's build needs no OTel-specific setup.

import { builtinModules, syncBuiltinESMExports } from 'node:module'
import { context, diag, DiagLogLevel, logs, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchLogRecordProcessor, LoggerProvider } from '@opentelemetry/sdk-logs'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { captureActionsLogs, serviceNameFrom, stderrDiagLogger } from './actions.js'

const INSTRUMENTATIONS = {
  // Patches node:http and node:https (see patchBuiltins).
  http: () => new HttpInstrumentation(),
  // Subscribes to undici's diagnostics channels by name: nothing to patch.
  undici: () => new UndiciInstrumentation(),
}

let started

/**
 * Starts the SDK and instrumentations, and flushes spans when the event loop drains.
 * Call it before the app makes its first instrumented call.
 *
 * @param {object} [options]
 * @param {string} [options.serviceName] Used when neither the serviceNameInput action
 *   input nor OTEL_SERVICE_NAME is set.
 * @param {string} [options.serviceNameInput] Action input that sets service.name at
 *   runtime. Defaults to "otel-service-name".
 * @param {boolean} [options.actionsLogs] Export what the action logs through
 *   @actions/core as log records. Defaults to true.
 * @param {string[]} [options.instrumentations] Any of "http", "undici". Defaults to all.
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

  // 1. SDK. OTEL_LOG_LEVEL (or the debug flag) turns on OTel's own diagnostic logging.
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

  // 2. Instrumentations. Enabling them comes first: their patch functions check it.
  const otelInstrumentations = instrumentations.map((n) => INSTRUMENTATIONS[n]())
  registerInstrumentations({ instrumentations: otelInstrumentations })
  const patched = patchBuiltins(otelInstrumentations)

  // 3. Flush when the event loop drains. An action's run() is often not awaited, so
  //    the caller can't simply wrap it.
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
    console.error(
      `${prefix}[otel] hooks=none patched=${patched.join(',') || 'nothing'} node=${process.versions.node} endpoint=${endpoint} service=${service}`,
    )
  }

  started = { provider, loggerProvider, shutdown }
  return started
}

// Does for builtins what a loader hook would do when Node loads them: hands each
// module's exports to the instrumentation's own patch function. The CommonJS exports
// object is the one module every import of a builtin shares, so patching it covers
// `import http from 'node:http'` everywhere; syncBuiltinESMExports() then updates
// named imports such as `import { request } from 'node:http'`.
function patchBuiltins(otelInstrumentations) {
  const patched = []
  for (const instrumentation of otelInstrumentations) {
    for (const definition of instrumentation.getModuleDefinitions()) {
      if (!builtinModules.includes(definition.name) || typeof definition.patch !== 'function') continue
      const moduleExports = process.getBuiltinModule(definition.name)
      definition.moduleExports = moduleExports
      definition.patch(moduleExports)
      patched.push(definition.name)
    }
  }
  syncBuiltinESMExports()
  return patched
}
