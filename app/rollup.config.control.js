// Same build without the plugin, used by verify.mjs as a negative control.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

export default {
  input: 'src/index.js',
  output: { file: 'dist-control/index.js', format: 'es' },
  plugins: [nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
