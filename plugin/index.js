// rollup-plugin-otel
//
// Adds OpenTelemetry auto-instrumentation to an ESM Rollup build. The app's source
// stays untouched: the plugin swaps the entry for a generated bootstrap that
//   1. registers import-in-the-middle's loader hooks (in-thread sync hooks when the
//      Node version supports them, otherwise the off-thread hook file it emits),
//   2. starts the OTel SDK and instrumentations,
//   3. loads the real entry with a dynamic import(), so the app's module graph is
//      resolved only after the hooks exist (the same effect as `node --import`).

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_FILE = fileURLToPath(import.meta.url)
const ENTRY_SUFFIX = '?otel-entry'
const INIT_ID = '\0otel-init'

const INSTRUMENTATIONS = {
  http: {
    pkg: '@opentelemetry/instrumentation-http',
    exportName: 'HttpInstrumentation',
    // Modules the ESM loader hook has to wrap so this instrumentation can patch them.
    modules: ['http', 'https'],
  },
  undici: {
    pkg: '@opentelemetry/instrumentation-undici',
    exportName: 'UndiciInstrumentation',
    // Subscribes to undici's diagnostics channels by name: needs no loader hook.
    modules: [],
  },
}

export default function otel(options = {}) {
  const {
    serviceName = 'unknown_service',
    instrumentations = Object.keys(INSTRUMENTATIONS),
    hookFileName = 'otel-hook.mjs',
    registerFileName = 'otel-iitm-register.mjs',
  } = options

  for (const name of instrumentations) {
    if (!INSTRUMENTATIONS[name]) {
      throw new Error(`[otel] unknown instrumentation "${name}"`)
    }
  }

  let ids
  let hookRef
  let registerRef

  // Resolve a dependency of this plugin from the plugin's own location, so it works
  // even when the app can't see the plugin's dependencies (pnpm, linked packages).
  async function resolveFrom(ctx, source, importer = PLUGIN_FILE) {
    const resolved = await ctx.resolve(source, importer, { skipSelf: true })
    if (!resolved || resolved.external) {
      ctx.error(`[otel] could not resolve "${source}" from ${importer}`)
    }
    return resolved.id
  }

  function isOwnChunk(id) {
    return ids !== undefined && (id === ids.iitmHook || id === ids.iitmRegister)
  }

  function initModule() {
    const j = JSON.stringify
    const include = [...new Set(instrumentations.flatMap((n) => INSTRUMENTATIONS[n].modules))]

    return [
      `import { register as registerAsyncHooks } from 'node:module'`,
      `import { register as registerSyncHooks, supportsSyncHooks } from ${j(ids.iitmRegisterHooks)}`,
      `import { context, diag, DiagConsoleLogger, DiagLogLevel, propagation, trace } from ${j(ids.api)}`,
      `import { CompositePropagator, W3CBaggagePropagator, W3CTraceContextPropagator } from ${j(ids.core)}`,
      `import { AsyncLocalStorageContextManager } from ${j(ids.contextAsyncHooks)}`,
      `import { BatchSpanProcessor, TracerProvider } from ${j(ids.sdkTrace)}`,
      `import { resourceFromAttributes } from ${j(ids.resources)}`,
      `import { OTLPTraceExporter } from ${j(ids.exporter)}`,
      `import { registerInstrumentations } from ${j(ids.instrumentation)}`,
      ...instrumentations.map(
        (n) => `import { ${INSTRUMENTATIONS[n].exportName} } from ${j(ids.instrumentations[n])}`,
      ),
      ``,
      `// 1. Loader hooks, before the app's module graph is loaded.`,
      `const include = ${j(include)}`,
      `const requested = process.env.OTEL_ROLLUP_HOOKS`,
      `const mode = include.length === 0 ? 'none'`,
      `  : requested === 'sync' || requested === 'async' ? requested`,
      `  : supportsSyncHooks() ? 'sync' : 'async'`,
      `if (mode === 'sync') {`,
      `  registerSyncHooks({ include })`,
      `} else if (mode === 'async') {`,
      `  registerAsyncHooks(import.meta.ROLLUP_FILE_URL_${hookRef}, { data: { include } })`,
      `}`,
      ``,
      `// 2. SDK. OTEL_LOG_LEVEL (or the debug flag) turns on OTel's own diagnostic logging.`,
      `const logLevel = (process.env.OTEL_LOG_LEVEL || (process.env.OTEL_ROLLUP_DEBUG ? 'info' : '')).toUpperCase()`,
      `if (logLevel && DiagLogLevel[logLevel] !== undefined) diag.setLogger(new DiagConsoleLogger(), DiagLogLevel[logLevel])`,
      `const endpoint = (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318').replace(/\\/+$/, '')`,
      `const provider = new TracerProvider({`,
      `  resource: resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || ${j(serviceName)} }),`,
      `  spanProcessors: [`,
      `    new BatchSpanProcessor({`,
      `      exporter: new OTLPTraceExporter({`,
      `        url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || endpoint + '/v1/traces',`,
      `      }),`,
      `    }),`,
      `  ],`,
      `})`,
      `trace.setGlobalTracerProvider(provider)`,
      `context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable())`,
      `propagation.setGlobalPropagator(new CompositePropagator({`,
      `  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],`,
      `}))`,
      ``,
      `// 3. Instrumentations. Their import-in-the-middle Hook()s receive each wrapped module.`,
      `registerInstrumentations({`,
      `  instrumentations: [${instrumentations.map((n) => `new ${INSTRUMENTATIONS[n].exportName}()`).join(', ')}],`,
      `})`,
      ``,
      `// 4. Flush when the event loop drains. The app's run() is often not awaited,`,
      `//    so the bootstrap can't simply wrap it.`,
      `process.once('beforeExit', () => {`,
      `  provider.shutdown().catch((err) => console.error('[otel] failed to flush spans:', err))`,
      `})`,
      ``,
      `if (process.env.OTEL_ROLLUP_DEBUG) {`,
      `  // In GitHub Actions, post the line as a notice annotation so it shows on the run page.`,
      `  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::notice title=otel::' : ''`,
      `  console.error(prefix + '[otel] hooks=' + mode + ' node=' + process.versions.node + ' endpoint=' + endpoint)`,
      `}`,
      ``,
    ].join('\n')
  }

  return {
    name: 'otel',

    async buildStart() {
      // import-in-the-middle must be the copy @opentelemetry/instrumentation uses:
      // the loader's wrappers report to its lib/register.js, which is where the
      // instrumentations' Hook() registrations live. Locate it with Node's resolver,
      // not this.resolve(): going through the plugin chain lets @rollup/plugin-commonjs
      // load lib/register.js as CommonJS before load() below can serve it as ESM.
      const requireFromPlugin = createRequire(PLUGIN_FILE)
      const requireFromInstrumentation = createRequire(requireFromPlugin.resolve('@opentelemetry/instrumentation'))
      const iitmDir = path.dirname(requireFromInstrumentation.resolve('import-in-the-middle/package.json'))
      const iitm = (file) => realpathSync(path.join(iitmDir, file))

      ids = {
        iitmHook: iitm('hook.mjs'),
        iitmRegisterHooks: iitm('register-hooks.mjs'),
        iitmCreateHook: iitm('create-hook.mjs'),
        iitmRegister: iitm('lib/register.js'),
        instrumentations: {},
      }
      ids.instrumentation = await resolveFrom(this, '@opentelemetry/instrumentation')
      ids.api = await resolveFrom(this, '@opentelemetry/api')
      ids.core = await resolveFrom(this, '@opentelemetry/core')
      ids.contextAsyncHooks = await resolveFrom(this, '@opentelemetry/context-async-hooks')
      ids.sdkTrace = await resolveFrom(this, '@opentelemetry/sdk-trace')
      ids.resources = await resolveFrom(this, '@opentelemetry/resources')
      ids.exporter = await resolveFrom(this, '@opentelemetry/exporter-trace-otlp-http')
      for (const name of instrumentations) {
        ids.instrumentations[name] = await resolveFrom(this, INSTRUMENTATIONS[name].pkg)
      }

      // import-in-the-middle's registry. It gets its own file because the wrapper
      // modules the loader generates import it by URL at runtime, and that URL has to
      // be the same module instance the bundle uses.
      registerRef = this.emitFile({
        type: 'chunk',
        id: ids.iitmRegister,
        fileName: registerFileName,
        preserveSignature: 'strict',
      })

      // The off-thread hook. module.register() needs a real file it can load in a
      // fresh module graph on the hooks thread.
      hookRef = this.emitFile({
        type: 'chunk',
        id: ids.iitmHook,
        fileName: hookFileName,
        preserveSignature: 'strict',
      })

      // Every output file is ESM; make the output folder say so on its own.
      this.emitFile({ type: 'asset', fileName: 'package.json', source: '{ "type": "module" }\n' })
    },

    resolveId: {
      order: 'pre',
      async handler(source, importer, opts) {
        if (source === INIT_ID) return { id: INIT_ID, moduleSideEffects: true }
        if (!opts.isEntry || source.endsWith(ENTRY_SUFFIX)) return null

        const resolved = await this.resolve(source, importer, { ...opts, skipSelf: true })
        if (!resolved || resolved.external || isOwnChunk(resolved.id)) return resolved

        // Keep the real file name in the id so the output keeps the entry's name.
        return { id: resolved.id + ENTRY_SUFFIX, moduleSideEffects: true }
      },
    },

    load: {
      order: 'pre',
      async handler(id) {
        if (id === INIT_ID) return initModule()

        if (id.endsWith(ENTRY_SUFFIX)) {
          const realId = id.slice(0, -ENTRY_SUFFIX.length)
          return `import ${JSON.stringify(INIT_ID)}\nawait import(${JSON.stringify(realId)})\n`
        }

        if (ids !== undefined && id === ids.iitmRegister) {
          return registerAsEsm(this, await readFile(id, 'utf8'))
        }

        return null
      },
    },

    transform: {
      order: 'pre',
      handler(code, id) {
        if (ids !== undefined && id === ids.iitmCreateHook) {
          // The loader computes the registry URL relative to its own file. Point it
          // at the emitted registry chunk, wherever that ends up.
          const needle = "new URL('lib/register.js', meta.url).toString()"
          if (!code.includes(needle)) {
            this.error('[otel] unsupported import-in-the-middle version: registry URL not found in create-hook.mjs')
          }
          return { code: code.replace(needle, `import.meta.ROLLUP_FILE_URL_${registerRef}`), map: null }
        }

        if (id.includes('/@opentelemetry/') && id.includes('/platform/browser/')) {
          this.warn(
            `[otel] bundled the browser build of ${id}. ` +
              'Add exportConditions: ["node"] to nodeResolve() or instrumentation will be a no-op.',
          )
        }

        if (id.includes('/node_modules/')) return inlineCreateRequireCalls(code)
        return null
      },
    },

    outputOptions(out) {
      // The output is several files now, so output.file becomes output.dir with the
      // same entry file name (action.yml can keep pointing at dist/index.js).
      if (!out.file) return null
      const { file, ...rest } = out
      return { ...rest, dir: path.dirname(file), entryFileNames: path.basename(file) }
    },

    renderStart(out) {
      if (out.format !== 'es') {
        this.error(`[otel] output.format must be "es" (got "${out.format}")`)
      }
      if (out.inlineDynamicImports) {
        this.error('[otel] output.inlineDynamicImports must be off: the app has to load after the hooks')
      }
    },

    generateBundle(_, bundle) {
      // Anything still loaded with a runtime require() isn't in the output, and an
      // action has no node_modules to find it in.
      const leftover = new Set()
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk') runtimeRequires(file.code).forEach((s) => leftover.add(s))
      }
      if (leftover.size > 0) {
        this.warn(`[otel] these modules are still loaded with require() at runtime and are not bundled: ${[...leftover].join(', ')}`)
      }

      // The hook file runs on the loader thread. If chunking ever made it import the
      // bootstrap, the SDK and the app would run there too. Fail the build instead.
      const seen = new Set()
      const visit = (fileName) => {
        if (seen.has(fileName)) return
        seen.add(fileName)
        const chunk = bundle[fileName]
        if (!chunk || chunk.type !== 'chunk') return
        if (chunk.moduleIds.includes(INIT_ID) || chunk.facadeModuleId?.endsWith(ENTRY_SUFFIX)) {
          this.error(`[otel] ${hookFileName} would load the bootstrap on the hooks thread (via ${fileName})`)
        }
        chunk.imports.forEach(visit)
      }
      visit(hookFileName)
    },
  }
}

// ESM builds made by tsdown/rolldown (OTel's among them) load CommonJS dependencies
// through a createRequire(import.meta.url) shim, which Rollup can't follow. Turn each
// shim call with a literal, non-builtin specifier into a static import so it gets
// bundled. Builtins are left alone: they're always there at runtime.
const SHIM_DECLARATION = /(?:var|let|const)\s+([\w$]+)\s*=\s*(?:\/\*[^*]*\*\/\s*)?createRequire\(\s*import\.meta\.url\s*\)/g
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g

function shimNames(code) {
  const names = [...code.matchAll(SHIM_DECLARATION)].map((m) => m[1])
  // rolldown usually declares the shim once in a shared runtime module and imports it:
  //   import { __require } from "./_virtual/_rolldown/runtime.mjs"
  for (const [, specifiers, source] of code.matchAll(NAMED_IMPORT)) {
    if (!source.includes('rolldown/runtime')) continue
    for (const specifier of specifiers.split(',')) {
      const m = /^\s*__require(?:\s+as\s+([\w$]+))?\s*$/.exec(specifier)
      if (m) names.push(m[1] ?? '__require')
    }
  }
  return names
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])
}

function inlineCreateRequireCalls(code) {
  const names = shimNames(code)
  if (names.length === 0) return null

  const imports = new Map()
  let changed = code
  for (const name of names) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*(["'])([^"']+)\\1\\s*\\)`, 'g')
    changed = changed.replace(call, (whole, _quote, specifier) => {
      if (isBuiltin(specifier)) return whole
      if (!imports.has(specifier)) imports.set(specifier, `__otel_cjs_${imports.size}`)
      return `__otel_interop(${imports.get(specifier)})`
    })
  }
  if (imports.size === 0) return null

  const header = [
    ...[...imports].map(([specifier, local]) => `import * as ${local} from ${JSON.stringify(specifier)};`),
    // CommonJS modules come through as their module.exports on `default`.
    'const __otel_interop = (m) => (m && m.default !== undefined ? m.default : m);',
  ].join('\n')
  if (changed.startsWith('#!')) {
    const firstLineEnd = changed.indexOf('\n') + 1
    return { code: `${changed.slice(0, firstLineEnd)}${header}\n${changed.slice(firstLineEnd)}`, map: null }
  }
  return { code: `${header}\n${changed}`, map: null }
}

function runtimeRequires(chunkCode) {
  const found = new Set()
  // Crude comment stripping: good enough for a warning, avoids flagging examples in docs.
  const code = chunkCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const name of new Set(['require', '__require', ...shimNames(code)])) {
    const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*(["'])([^"']+)\\1\\s*\\)`, 'g')
    for (const m of code.matchAll(call)) {
      if (!isBuiltin(m[2]) && !m[2].startsWith('.')) found.add(m[2])
    }
  }
  return found
}

// import-in-the-middle's lib/register.js is CommonJS. Its generated wrappers import
// it as ESM with named imports, and it must be one module shared by the bundle and
// the wrappers, so serve it to Rollup as ESM with explicit named exports.
function registerAsEsm(ctx, code) {
  const names = []
  const esm = code.replace(/^exports\.(\w+) = (\w+)[ \t]*$/gm, (_, exported, local) => {
    names.push(exported === local ? local : `${local} as ${exported}`)
    return ''
  })
  if (!names.includes('register') || /^\s*(module\.)?exports\b/m.test(esm)) {
    ctx.error('[otel] unsupported import-in-the-middle version: unexpected lib/register.js exports')
  }
  return `${esm}\nexport { ${names.join(', ')} }\n`
}
