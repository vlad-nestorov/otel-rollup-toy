// Option 2: rewrite the instrumented library's source at build time.
//
// The off-the-shelf code-transformer plugin injects diagnostics_channel TracingChannel
// calls into dataloader's own functions as they're bundled, using the configs
// otel-sdk-init exports. At runtime otel-sdk-init subscribes to those channels.
// Everything is bundled: no loader hooks, no node_modules to ship.
import codeTransformer from '@apm-js-collab/code-transformer-bundler-plugins/rollup'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import { codeTransforms } from 'otel-sdk-init/transforms'

export default {
  // src/main.js starts OpenTelemetry, then imports src/index.js dynamically.
  input: { index: 'src/main.js' },
  output: { dir: 'dist', format: 'es' },
  plugins: [
    // First, so it sees dataloader's original CommonJS source before commonjs() converts it.
    codeTransformer({ instrumentations: codeTransforms }),
    nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
  ],
}
