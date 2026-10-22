// Option 3: route imports of instrumented libraries through generated wrapper modules.
//
// A few lines of inline Rollup hooks (no plugin package) replace each import of a
// wrapped library with a virtual module that imports the real one and exports what
// otel-sdk-init's instrumentModule() returns: the library patched by the stock OTel
// instrumentation. Everything is bundled: no loader hooks, no node_modules to ship.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

// Libraries to wrap. Each needs a matching instrumentation in otel-sdk-init.
const WRAPPED = ['dataloader']
const PREFIX = '\0otel-wrap:'

const wrapInstrumentedLibraries = {
  name: 'wrap-instrumented-libraries',
  resolveId(source, importer) {
    // The wrapper's own import of the library resolves normally.
    if (!WRAPPED.includes(source) || importer?.startsWith(PREFIX)) return null
    return { id: PREFIX + source, moduleSideEffects: true }
  },
  load(id) {
    if (!id.startsWith(PREFIX)) return null
    const name = id.slice(PREFIX.length)
    // Bundled code has no package.json to read at runtime, so bake the version in now.
    const requireFromApp = createRequire(path.join(process.cwd(), 'package.json'))
    const { version } = JSON.parse(readFileSync(requireFromApp.resolve(`${name}/package.json`), 'utf8'))
    return [
      `import * as original from ${JSON.stringify(name)}`,
      `import { instrumentModule } from 'otel-sdk-init'`,
      // A CommonJS library's module.exports arrives as the default export.
      `export default instrumentModule(${JSON.stringify(name)}, ${JSON.stringify(version)}, original.default ?? original)`,
    ].join('\n')
  },
}

export default {
  // src/main.js starts OpenTelemetry, then imports src/index.js dynamically, so
  // start() runs before any wrapper module is evaluated.
  input: { index: 'src/main.js' },
  output: { dir: 'dist', format: 'es' },
  plugins: [
    wrapInstrumentedLibraries,
    nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
  ],
}
