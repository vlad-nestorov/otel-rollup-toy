// The action without OpenTelemetry, used by verify.mjs as a negative control:
// src/otel.js is replaced with an empty module, so start() is never called.
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

const withoutOtel = {
  name: 'without-otel',
  load: (id) => (id.endsWith('/src/otel.js') ? '' : null),
}

export default {
  input: 'src/index.js',
  output: { file: 'dist-control/index.js', format: 'es' },
  plugins: [withoutOtel, nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
