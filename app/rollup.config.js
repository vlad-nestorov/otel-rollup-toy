import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

// Nothing OpenTelemetry-specific: src/otel.js starts the SDK, and otel-sdk-init arrives
// as one prebundled CommonJS file that commonjs() bundles like any other dependency.
export default {
  input: 'src/index.js',
  output: { file: 'dist/index.js', format: 'es' },
  plugins: [nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
