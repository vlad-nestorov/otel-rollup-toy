// The action without OpenTelemetry: src/index.js as the entry, everything bundled.
// verify.mjs uses it as a negative control.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

export default {
  input: 'src/index.js',
  output: { file: 'dist-control/index.js', format: 'es' },
  plugins: [nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
