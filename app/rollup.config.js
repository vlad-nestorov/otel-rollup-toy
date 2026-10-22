import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

export default {
  input: 'src/index.js',
  output: { file: 'dist/index.js', format: 'es', inlineDynamicImports: true },
  plugins: [
    // 'require' picks OTel's CommonJS builds. Their ESM builds load some CommonJS
    // dependencies (e.g. forwarded-parse) through a createRequire shim Rollup can't
    // follow; the CommonJS builds use plain require(), which commonjs() bundles.
    nodeResolve({ exportConditions: ['node', 'require'], preferBuiltins: true }),
    commonjs(),
  ],
}
