// Prebundles otel-sdk-init into one CommonJS file, so apps that bundle it never see
// OpenTelemetry's own packages.
//
// The 'require' export condition picks OTel's CommonJS builds. Those load their CommonJS
// dependencies with a plain require(), which @rollup/plugin-commonjs bundles. The ESM
// builds load some of them through a createRequire shim instead (forwarded-parse, in
// @opentelemetry/instrumentation-http), which no bundler follows; see the README.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

export default {
  input: 'src/index.js',
  // import-in-the-middle stays a dependency. rollup-plugin-otel emits its loader hook
  // and registry as separate files, and the instrumentations' Hook() calls have to
  // register with that same registry, so the app's build has to bundle the one copy.
  external: (id) => id === 'import-in-the-middle' || id.startsWith('import-in-the-middle/'),
  output: { file: 'dist/index.cjs', format: 'cjs' },
  plugins: [nodeResolve({ exportConditions: ['node', 'require'], preferBuiltins: true }), commonjs()],
}
