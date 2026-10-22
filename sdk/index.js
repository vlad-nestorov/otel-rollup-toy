// otel-sdk-init (option 3: build-time wrapper modules)
//
// Starts OpenTelemetry tracing for a Node app or GitHub action without loader hooks.
// Instead of a hook handing each library to its instrumentation as Node loads it, the
// build routes imports of instrumented libraries through generated wrapper modules that
// call instrumentModule(). That applies the stock OTel instrumentation's own patch
// function, so its spans are unchanged. node:http is covered by Node's http channels
// and fetch by undici's, so the whole SDK can be bundled.

import { context, diag, DiagConsoleLogger, DiagLogLevel, propagation, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { DataloaderInstrumentation } from '@opentelemetry/instrumentation-dataloader'
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { instrumentHttpClient } from './channels.js'

const INSTRUMENTATIONS = {
  // Node's built-in http.client.* channels.
  http: () => instrumentHttpClient(),
  // undici publishes its own channels; the stock OTel instrumentation subscribes to them.
  undici: () => new UndiciInstrumentation(),
  // Patches dataloader when a wrapper module hands it to instrumentModule().
  dataloader: () => new DataloaderInstrumentation(),
}

let started
// Stock OTel instrumentations whose module definitions instrumentModule() applies.
let moduleInstrumentations = []

/**
 * Starts the SDK and the instrumentations. Call it before any wrapper module is
 * evaluated, which in practice means before the app's modules are imported.
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

  const otelInstrumentations = instrumentations.map((n) => INSTRUMENTATIONS[n]()).filter(Boolean)
  // Enables them, which their patch functions check before wrapping anything.
  registerInstrumentations({ instrumentations: otelInstrumentations })
  moduleInstrumentations = otelInstrumentations

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

/**
 * Runs every matching OTel module definition's patch on a library's exports, the way
 * import-in-the-middle or require-in-the-middle would when Node loads it, and returns
 * what the wrapper module should export in its place.
 *
 * @param {string} name Package name, e.g. "dataloader".
 * @param {string} version The bundled package's version, read at build time.
 * @param {unknown} moduleExports For a CommonJS package, its module.exports.
 */
export function instrumentModule(name, version, moduleExports) {
  if (!started) {
    console.error(`[otel] ${name} was loaded before start(); it won't be instrumented`)
    return moduleExports
  }

  let result = moduleExports
  for (const instrumentation of moduleInstrumentations) {
    for (const definition of instrumentation.getModuleDefinitions()) {
      if (definition.name !== name) continue
      if (!definition.supportedVersions.some((range) => satisfies(version, range))) continue
      definition.moduleExports = result
      definition.moduleVersion = version
      result = definition.patch?.(result, version) ?? result
    }
  }
  return result
}

// Just enough semver for the ranges OTel module definitions use: "*", "||" alternatives
// and space-separated comparators such as ">=2.0.0 <3".
function satisfies(version, range) {
  const target = parseVersion(version)
  return range.split('||').some((alternative) =>
    alternative
      .trim()
      .split(/\s+/)
      .every((comparator) => {
        if (comparator === '' || comparator === '*' || comparator === 'x') return true
        const [, op = '=', bound] = /^(>=|<=|>|<|=)?v?(.+)$/.exec(comparator)
        const order = compareVersions(target, parseVersion(bound))
        return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[op]
      }),
  )
}

function parseVersion(version) {
  return version.split('-')[0].split('.').map((part) => Number.parseInt(part, 10) || 0)
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}
