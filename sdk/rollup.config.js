// Prebundles otel-sdk-init into one CommonJS file, so apps that bundle it never see
// OpenTelemetry's own packages and need no OTel-specific build setup.
//
// The 'require' export condition picks OTel's CommonJS builds. Those load their CommonJS
// dependencies with a plain require(), which @rollup/plugin-commonjs bundles. The ESM
// builds load some of them through a createRequire shim instead (forwarded-parse, in
// @opentelemetry/instrumentation-http), which no bundler follows; see the README.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

export default {
  input: 'src/index.js',
  output: { file: 'dist/index.cjs', format: 'cjs' },
  plugins: [
    nodeResolve({ exportConditions: ['node', 'require'], preferBuiltins: true }),
    // 'auto' wraps only the modules that need lazy evaluation (cycles, conditional
    // requires) instead of every module, which keeps the bundle about 70 KB smaller.
    commonjs({ strictRequires: 'auto' }),
  ],
}
