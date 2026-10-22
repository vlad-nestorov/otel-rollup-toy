import { builtinModules } from 'node:module'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

// ---------------------------------------------------------------------------
// Bundle CommonJS dependencies that OTel's ESM builds load through a require shim
// ---------------------------------------------------------------------------
//
// Where the shim comes from
//   @opentelemetry/instrumentation-http imports a CommonJS package with TypeScript's
//   import-equals syntax: `import forwardedParse = require('forwarded-parse')`. OTel
//   builds with tsdown (rolldown), which keeps require() semantics in Node ESM output
//   by building a real require with createRequire instead of turning it into an import.
//   The published ESM build (0.300.0) has:
//
//     // dist/_virtual/_rolldown/runtime.mjs
//     import { createRequire } from "node:module";
//     var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
//     export { __require };
//
//     // dist/utils.mjs
//     import { __require } from "./_virtual/_rolldown/runtime.mjs";
//     const forwardedParse = __require("forwarded-parse");
//
// Why Rollup doesn't bundle it
//   @rollup/plugin-commonjs only rewrites the free `require` of CommonJS modules. Here
//   __require is an ordinary imported function, so the call stays in the output and
//   forwarded-parse is never bundled. At runtime import.meta.url is the bundle's own URL,
//   so the call resolves from dist/: it finds the repo's node_modules during local runs
//   and works by accident, then throws "Cannot find module" once deployed without them.
//
// What this transform does
//   In files under node_modules, every call through such a shim whose argument is a
//   string literal naming a non-builtin module becomes a static import, which Rollup
//   resolves and bundles like any other:
//
//     import * as __otel_cjs_0 from "forwarded-parse";
//     const __otel_interop = (m) => (m && m.default !== undefined ? m.default : m);
//     const forwardedParse = __otel_interop(__otel_cjs_0);
//
//   commonjs() exposes a CommonJS module's module.exports as its default export, which
//   __otel_interop returns: the value require() would have returned. The shim is then
//   unused and tree-shaken away.
//
// Limits
//   - Only string-literal specifiers; a computed __require(name) stays a runtime call.
//     verify.mjs fails if any non-builtin module is still required at runtime.
//   - Builtins (node:http, fs, ...) keep the runtime call: Node always has them.
//   - Assumes the required module is CommonJS (require() of an ES module would return
//     its namespace; the interop returns its default export when it has one).
//   - The import runs when the importing module is evaluated, not at the call. For a
//     top-level import-equals, as in OTel, that's the same moment.
//
// Why not exportConditions: ['node', 'require']
//   That picks OTel's CommonJS builds, which use plain require() that commonjs() bundles,
//   but CommonJS can't be tree-shaken: this bundle grows from about 312 KB to about
//   1,018 KB, mostly @opentelemetry/semantic-conventions and sdk-metrics.

// Local names bound to a createRequire(import.meta.url) shim in a module: imported from
// rolldown's runtime module (as published), or declared in the file itself.
function shimNames(code) {
  const names = []
  for (const [, specifiers, source] of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!source.includes('rolldown/runtime')) continue
    for (const specifier of specifiers.split(',')) {
      const m = /^\s*__require(?:\s+as\s+([\w$]+))?\s*$/.exec(specifier)
      if (m) names.push(m[1] ?? '__require')
    }
  }
  for (const [, name] of code.matchAll(/(?:var|let|const)\s+([\w$]+)\s*=[^;]*?createRequire\(\s*import\.meta\.url\s*\)/g)) {
    names.push(name)
  }
  return names
}

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0])

const bundleRequireShims = {
  name: 'bundle-require-shims',
  transform(code, id) {
    if (!id.includes('/node_modules/')) return null
    const names = shimNames(code)
    if (names.length === 0) return null

    const imports = new Map() // specifier -> local namespace binding
    let changed = code
    for (const name of names) {
      // `name("specifier")` with a string literal; not `obj.name(...)` or `xname(...)`.
      const call = new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\(\\s*(["'])([^"']+)\\1\\s*\\)`, 'g')
      changed = changed.replace(call, (whole, _quote, specifier) => {
        if (isBuiltin(specifier)) return whole
        if (!imports.has(specifier)) imports.set(specifier, `__otel_cjs_${imports.size}`)
        return `__otel_interop(${imports.get(specifier)})`
      })
    }
    if (imports.size === 0) return null

    const header = [...imports]
      .map(([specifier, local]) => `import * as ${local} from ${JSON.stringify(specifier)};`)
      .concat('const __otel_interop = (m) => (m && m.default !== undefined ? m.default : m);')
      .join('\n')
    return { code: `${header}\n${changed}`, map: null }
  },
}

export default {
  input: 'src/index.js',
  output: { file: 'dist/index.js', format: 'es', inlineDynamicImports: true },
  plugins: [
    // Runs before commonjs(), on OTel's ESM source as published.
    bundleRequireShims,
    nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
  ],
}
