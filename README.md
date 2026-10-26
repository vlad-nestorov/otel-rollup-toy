# otel-rollup-toy

Ways to add OpenTelemetry auto-instrumentation to a bundled Node.js ESM app, tried on a toy
GitHub JavaScript action. Actions are the hard case: the runner starts `dist/index.js` on
its own Node with no flags (so no `--import`), and there's no `node_modules` next to it, so
everything has to be in the bundle.

Each approach lives on its own branch, with a README that explains it in detail. This
branch only compares them.

## What every branch checks

Every branch builds the same toy action, which calls `http.get` and `fetch` (the option
branches also use `dataloader`). `npm run verify` builds it, runs it from a folder with no
`node_modules` against a fake OTLP collector, and checks that each call exported a span and
that the `traceparent` header each request carried points at that span. A build without
OpenTelemetry must export nothing. CI runs `verify` and also runs the built action with
`uses:`, so the GitHub runner launches it on its own Node 24. Both jobs pass on every branch.

## Instrumenting Node's builtins

Four branches differ along two lines: whether a Rollup plugin is involved, and how they get
past one OpenTelemetry dependency that doesn't bundle from OTel's ESM builds.

| | With `rollup-plugin-otel` | Without a plugin |
| --- | --- | --- |
| **OTel ESM builds + shim transform** | [`sdk-esm-shim-transform`][esm-plugin]: 451 KB | [`sdk-esm-shim-transform-no-plugin`][esm-no-plugin]: 320 KB |
| **SDK prebundled from OTel's CommonJS builds** | [`sdk-prebundled-cjs`][cjs-plugin]: 1,105 KB | [`sdk-prebundled-cjs-no-plugin`][cjs-no-plugin]: 972 KB |

Sizes are the action's total JavaScript output, measured in CI with OpenTelemetry JS 3.0
and Rollup 4.

### With or without the plugin

**With the plugin**, the app's source has no OpenTelemetry code at all: `rollup.config.js`
adds `otel({ sdkOptions: { serviceName } })`. The plugin swaps the entry for a bootstrap
that calls the SDK's `start()`, which registers import-in-the-middle's loader hooks
(in-thread `module.registerHooks()` on Node >= 22.22.3 or >= 24.11.1, otherwise
`module.register()` on a hooks thread), and then loads the app with a dynamic `import()`.
The plugin also emits the hook and registry files those loader hooks need, so the output is
several files.

**Without a plugin**, the app's `src/index.js` imports `src/otel.js` first, and that calls
`start()`. When everything is bundled, the only modules a loader hook would ever see are
Node's builtins, and those can be patched in place: `start()` hands `node:http` and
`node:https` to the stock `HttpInstrumentation`'s own patch function, then calls
`syncBuiltinESMExports()` so named imports see the patch too. With no loader hooks there are
no hook files, so the output is one file and drops the 128 KB of import-in-the-middle's
loader. The limits: only builtins get instrumented this way, and code that grabs a builtin
function before `start()` runs keeps the unpatched one.

All four cover `fetch` the same way, with the stock undici instrumentation, which listens on
diagnostics channels.

### Shim transform or CommonJS prebundle

`@opentelemetry/instrumentation-http` imports the CommonJS package `forwarded-parse` with
TypeScript's `import x = require()`. OTel's ESM build keeps that a runtime call through a
`createRequire` shim, which Rollup can't follow. Bundled as is, the action crashes with
"Cannot find module 'forwarded-parse'" once it runs without `node_modules`.

- **Shim transform:** a `transform` hook rewrites such calls into static imports that
  Rollup bundles. It lives in the plugin, or inline in the app's `rollup.config.js` (about
  100 lines, half of them comments) when there's no plugin. OTel's ESM builds stay
  tree-shakeable.
- **CommonJS prebundle:** the SDK package builds itself into one CommonJS file from OTel's
  CommonJS builds, whose plain `require()` calls `@rollup/plugin-commonjs` bundles. No
  transform anywhere; without the plugin, the app's config is just `nodeResolve()` and
  `commonjs()`. But CommonJS can't be tree-shaken: the prebundle carries all of
  `@opentelemetry/semantic-conventions` (285 KB, against 16 KB from the ESM build) and
  `sdk-metrics` (about 130 KB, which the ESM build leaves out entirely), so the output
  roughly triples.

Neither would be needed if OTel's build bundled `forwarded-parse` differently, for example
with rolldown's
[`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require).

## Instrumenting a bundled library

Three option branches look at a different problem: instrumenting a third-party library
bundled into the action (`dataloader`), without a dedicated Rollup plugin. They start from
an earlier version of the toy and each uses its own variant of the SDK.

| Branch | How `dataloader` gets instrumented | Ships `node_modules` | Stock OTel instrumentations |
| --- | --- | --- | --- |
| [`option-1-externalize`][option-1] | The SDK and instrumented libraries stay out of the bundle; import-in-the-middle's loader hooks see them load from `node_modules` | yes | used unchanged, http too |
| [`option-2-code-transformer`][option-2] | orchestrion's code transformer wraps the library's functions in diagnostics `TracingChannel`s at build time; the SDK subscribes and makes spans | no | not used: each library needs a transform config and a subscriber |
| [`option-3-virtual-wrapper`][option-3] | Inline Rollup hooks route `import 'dataloader'` through a generated module that runs the stock instrumentation's `patch()` on its exports | no | used, for CommonJS libraries whose API is `module.exports` |

Options 2 and 3 take `http.get` spans from Node's own http client diagnostics channels
instead of OTel's http instrumentation. Their sizes aren't comparable with the table above,
since the app has an extra dependency and the SDKs differ.

## In short

- Smallest output: `sdk-esm-shim-transform-no-plugin` (320 KB, one file), at the cost of a
  transform in the app's Rollup config.
- Simplest build: `sdk-prebundled-cjs-no-plugin`, a stock Rollup config, at about three
  times the size.
- No OpenTelemetry code in the app's source: the plugin branches. In a fully bundled action
  their loader hooks only ever see builtins, so the extra loader and files buy convenience
  rather than coverage.
- A third-party library bundled into the action: option 3 reuses the stock
  instrumentation, option 2 works without patching; option 1 only if you ship
  `node_modules`.

Before these branches were renamed, `main` held what's now on `sdk-esm-shim-transform`.

[esm-plugin]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/sdk-esm-shim-transform
[esm-no-plugin]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/sdk-esm-shim-transform-no-plugin
[cjs-plugin]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/sdk-prebundled-cjs
[cjs-no-plugin]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/sdk-prebundled-cjs-no-plugin
[option-1]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/option-1-externalize
[option-2]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/option-2-code-transformer
[option-3]: https://github.com/vlad-nestorov/otel-rollup-toy/tree/option-3-virtual-wrapper
