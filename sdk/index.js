// otel-sdk-init
//
// Starts OpenTelemetry tracing for a Node app or GitHub action. It doesn't know about
// any bundler: whatever loads it before the app (rollup-plugin-otel, or node --import)
// only has to call start() first and, for Node versions without in-thread module hooks,
// pass hookUrl, the URL of a file exporting import-in-the-middle's loader hooks.

import { register as registerAsyncHooks } from 'node:module'
import { context, diag, DiagConsoleLogger, DiagLogLevel, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { register as registerSyncHooks, supportsSyncHooks } from 'import-in-the-middle/register-hooks.mjs'

const INSTRUMENTATIONS = {
  http: {
    create: () => new HttpInstrumentation(),
    // Modules the ESM loader hook has to wrap so this instrumentation can patch them.
    modules: ['http', 'https'],
  },
  undici: {
    create: () => new UndiciInstrumentation(),
    // Subscribes to undici's diagnostics channels by name: needs no loader hook.
    modules: [],
  },
}

let started

/**
 * Registers the loader hooks, starts the SDK and instrumentations, and flushes spans
 * when the event loop drains. Call it before the app's modules are loaded.
 *
 * @param {object} [options]
 * @param {string} [options.serviceName] Used when OTEL_SERVICE_NAME isn't set.
 * @param {string[]} [options.instrumentations] Any of "http", "undici". Defaults to all.
 * @param {string | URL} [options.hookUrl] File exporting import-in-the-middle's loader
 *   hooks, for Node versions without module.registerHooks() support.
 */
export function start({ serviceName = 'unknown_service', instrumentations = Object.keys(INSTRUMENTATIONS), hookUrl } = {}) {
  if (started) return started

  for (const name of instrumentations) {
    if (!INSTRUMENTATIONS[name]) throw new Error(`[otel] unknown instrumentation "${name}"`)
  }

  // 1. Loader hooks, before the app's module graph is loaded.
  const include = [...new Set(instrumentations.flatMap((n) => INSTRUMENTATIONS[n].modules))]
  const hooks = registerHooks(include, hookUrl)

  // 2. SDK. OTEL_LOG_LEVEL (or the debug flag) turns on OTel's own diagnostic logging.
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

  // 3. Instrumentations. Their import-in-the-middle Hook()s receive each wrapped module.
  registerInstrumentations({ instrumentations: instrumentations.map((n) => INSTRUMENTATIONS[n].create()) })

  // 4. Flush when the event loop drains. An action's run() is often not awaited, so
  //    the caller can't simply wrap it.
  process.once('beforeExit', () => {
    provider.shutdown().catch((err) => console.error('[otel] failed to flush spans:', err))
  })

  if (process.env.OTEL_ROLLUP_DEBUG) {
    // In GitHub Actions, post the line as a notice annotation so it shows on the run page.
    const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::notice title=otel::' : ''
    console.error(`${prefix}[otel] hooks=${hooks} node=${process.versions.node} endpoint=${endpoint}`)
  }

  started = { provider, hooks, shutdown: () => provider.shutdown() }
  return started
}

function registerHooks(include, hookUrl) {
  if (include.length === 0) return 'none'

  const requested = process.env.OTEL_ROLLUP_HOOKS
  const mode = requested === 'sync' || requested === 'async' ? requested : supportsSyncHooks() ? 'sync' : 'async'

  if (mode === 'sync') {
    registerSyncHooks({ include })
  } else {
    if (!hookUrl) {
      throw new Error(
        `[otel] Node ${process.versions.node} needs the off-thread loader hook, but start() got no hookUrl`,
      )
    }
    registerAsyncHooks(hookUrl, { data: { include } })
  }
  return mode
}
