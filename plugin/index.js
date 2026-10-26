// rollup-plugin-otel
//
// The Rollup half of adding OpenTelemetry to an ESM build without touching app source.
// The plugin swaps the entry for a generated bootstrap that
//   1. imports the SDK package (otel-sdk-init by default) and calls its start(), passing
//      the URL of the loader-hook file this plugin emits,
//   2. loads the real entry with a dynamic import(), so the app's module graph is
//      resolved only after the hooks exist (the same effect as `node --import`).
// Everything about what gets instrumented and where spans go lives in the SDK package,
// which ships prebundled with its OpenTelemetry dependencies. This plugin only deals with
// bundling: the entry swap, the files import-in-the-middle needs at runtime, and output
// options.

import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'

const ENTRY_SUFFIX = '?otel-entry'
const INIT_ID = '\0otel-init'

export default function otel(options = {}) {
  const {
    // The package whose start() initializes OpenTelemetry, resolved from the project.
    sdk = 'otel-sdk-init',
    // Passed to start(). Must be JSON-serializable: it's written into the bundle.
    sdkOptions = {},
    hookFileName = 'otel-hook.mjs',
    registerFileName = 'otel-iitm-register.mjs',
    // Runtime requires known to be optional (wrapped in try/catch by their callers),
    // left out of the "not bundled" warning. `debug` probes for supports-color this way.
    optionalRequires = ['supports-color'],
  } = options

  let ids
  let hookRef
  let registerRef

  function isOwnChunk(id) {
    return ids !== undefined && (id === ids.iitmHook || id === ids.iitmRegister)
  }

  function initModule() {
    const config = `Object.assign(${JSON.stringify(sdkOptions)}, { hookUrl: import.meta.ROLLUP_FILE_URL_${hookRef} })`
    return `import { start } from ${JSON.stringify(ids.sdk)}\nstart(${config})\n`
  }

  return {
    name: 'otel',

    buildStart() {
      // Locate everything with Node's resolver rather than this.resolve(): going through
      // the plugin chain lets @rollup/plugin-commonjs load import-in-the-middle's
      // lib/register.js as CommonJS before load() below can serve it as ESM.
      const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'))
      let sdkFile
      try {
        sdkFile = realpathSync(requireFromProject.resolve(sdk))
      } catch {
        this.error(`[otel] could not resolve the SDK package "${sdk}" from ${process.cwd()}; is it installed and built?`)
      }

      // import-in-the-middle must be the copy the SDK bundle requires: the loader's
      // wrappers report to its lib/register.js, which is where the instrumentations'
      // Hook() registrations live.
      let iitmDir
      try {
        iitmDir = path.dirname(createRequire(sdkFile).resolve('import-in-the-middle/package.json'))
      } catch {
        this.error(`[otel] could not find import-in-the-middle from ${sdk} (${sdkFile})`)
      }
      const iitm = (file) => realpathSync(path.join(iitmDir, file))

      ids = {
        sdk: sdkFile,
        iitmHook: iitm('hook.mjs'),
        iitmCreateHook: iitm('create-hook.mjs'),
        iitmRegister: iitm('lib/register.js'),
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
      // fresh module graph on the hooks thread. Its URL is handed to start().
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
        if (ids === undefined || id !== ids.iitmCreateHook) return null
        // The loader computes the registry URL relative to its own file. Point it at
        // the emitted registry chunk, wherever that ends up.
        const needle = "new URL('lib/register.js', meta.url).toString()"
        if (!code.includes(needle)) {
          this.error('[otel] unsupported import-in-the-middle version: registry URL not found in create-hook.mjs')
        }
        return { code: code.replace(needle, `import.meta.ROLLUP_FILE_URL_${registerRef}`), map: null }
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
      // action has no node_modules to find it in: requires commonjs() left in place, or
      // calls through a createRequire shim from a dependency's ESM build.
      const leftover = new Set()
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        for (const specifier of runtimeRequires(file.code)) {
          if (!optionalRequires.includes(specifier)) leftover.add(specifier)
        }
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
        if (
          chunk.moduleIds.includes(INIT_ID) ||
          chunk.moduleIds.includes(ids.sdk) ||
          chunk.facadeModuleId?.endsWith(ENTRY_SUFFIX)
        ) {
          this.error(`[otel] ${hookFileName} would load the bootstrap on the hooks thread (via ${fileName})`)
        }
        chunk.imports.forEach(visit)
      }
      visit(hookFileName)
    },
  }
}

// Specifiers of non-builtin modules a bundle chunk still loads at runtime: a plain
// require("x"), or a call through rolldown's createRequire shim, __require("x"). Used
// for the build warning.
const RUNTIME_REQUIRE = /(?<![\w$.])(?:require|__require[\w$]*)\(\s*(["'])([^"']+)\1\s*\)/g

function runtimeRequires(chunkCode) {
  const found = new Set()
  // Crude comment stripping: good enough for a warning, avoids flagging examples in docs.
  const code = chunkCode.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const [, , specifier] of code.matchAll(RUNTIME_REQUIRE)) {
    if (!isBuiltin(specifier) && !specifier.startsWith('.')) found.add(specifier)
  }
  return found
}

function isBuiltin(specifier) {
  return specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])
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
