import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import otel from 'rollup-plugin-otel'

export default {
  input: 'src/index.js',
  // A typical single-file action config. The plugin turns this into
  // { dir: 'dist', entryFileNames: 'index.js' } because the output is several files.
  output: { file: 'dist/index.js', format: 'es' },
  plugins: [
    nodeResolve({ exportConditions: ['node'], preferBuiltins: true }),
    commonjs(),
    otel({ serviceName: 'toy-action' }),
  ],
}
