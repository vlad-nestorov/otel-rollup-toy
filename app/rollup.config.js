// Option 1: keep runtime dependencies external.
//
// otel-sdk-init and dataloader are not bundled. Node loads them from node_modules at
// runtime, where import-in-the-middle's loader hooks (registered by start() in
// src/main.js) intercept dataloader, so the stock OTel instrumentation patches it as is.
// The cost: node_modules has to ship next to dist/.
import { readFileSync } from 'node:fs'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

const { dependencies } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const runtimeDependencies = Object.keys(dependencies)

export default {
  // src/main.js starts OpenTelemetry, then imports src/index.js dynamically.
  input: { index: 'src/main.js' },
  output: { dir: 'dist', format: 'es' },
  external: (id) => runtimeDependencies.some((dep) => id === dep || id.startsWith(`${dep}/`)),
  plugins: [nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
