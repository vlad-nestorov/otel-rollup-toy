// One self-contained bundle with OpenTelemetry started before the action, without a
// plugin package and without any OTel file in src/.
import path from 'node:path'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

const ACTION_ENTRY = path.resolve('src/index.js')

// The bundle's entry is a virtual module that imports `otel:start`, then the action.
// Static imports evaluate in order, so start() runs before any of the action's code.
const startOtelFirst = {
  name: 'start-otel-first',
  resolveId(source) {
    return source === 'otel:entry' || source === 'otel:start' ? `\0${source}` : null
  },
  load(id) {
    if (id === '\0otel:entry') return `import 'otel:start'\nimport ${JSON.stringify(ACTION_ENTRY)}\n`
    if (id === '\0otel:start') return `import { start } from 'otel-sdk-init'\nstart({ serviceName: 'toy-action' })\n`
    return null
  },
}

export default {
  input: 'otel:entry',
  output: { file: 'dist/index.js', format: 'es', inlineDynamicImports: true },
  plugins: [
    startOtelFirst,
    // 'require' picks OTel's CommonJS builds. Their ESM builds load some CommonJS
    // dependencies (e.g. forwarded-parse) through a createRequire shim Rollup can't
    // follow; the CommonJS builds use plain require(), which commonjs() bundles.
    nodeResolve({ exportConditions: ['node', 'require'], preferBuiltins: true }),
    commonjs(),
  ],
}
