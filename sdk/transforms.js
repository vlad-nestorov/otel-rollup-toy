// Build-time half of otel-sdk-init's library instrumentation (option 2).
//
// Configs for @apm-js-collab/code-transformer (orchestrion). Passed to its bundler
// plugin, they rewrite the named functions in the library's own source so each call is
// wrapped in a diagnostics_channel TracingChannel named
// `orchestrion:<module.name>:<channelName>`. index.js subscribes to those channels.

export const codeTransforms = [
  {
    // dataloader 2.x is compiled with Babel's loose mode, so DataLoader#load is
    // `_proto.load = function load(key) { ... }` in index.js.
    channelName: 'load',
    module: { name: 'dataloader', versionRange: '>=2.0.0 <3', filePath: 'index.js' },
    functionQuery: { expressionName: 'load', kind: 'Async' },
  },
]
