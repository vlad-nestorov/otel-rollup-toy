# otel-rollup-toy

A Rollup plugin and an SDK package that add OpenTelemetry auto-instrumentation to an ESM
build, plus a toy GitHub JavaScript action that uses them without any OTel code in its source.

```
plugin/   rollup-plugin-otel: the Rollup part only, no OpenTelemetry dependencies
sdk/      otel-sdk-init: start() sets up loader hooks, the SDK, instrumentations and flushing
app/      toy action: depends on otel-sdk-init; src/ has no OTel code; rollup.config.js adds otel()
```

## Run it

Needs Node 22 or later.

```sh
npm install
npm run verify
```

`verify` builds the action, copies `dist/` to a temp folder with no `node_modules`
(like an action checkout on a runner), runs it against a local fake collector, then:

- checks the build output: `index.js` (bootstrap), `otel-hook.mjs` (loader hook),
  `otel-iitm-register.mjs` (import-in-the-middle registry), `package.json` (type: module),
  and that the app code is loaded with a dynamic `import()` rather than inlined in the entry
- checks that `http.get` and `fetch` each exported a CLIENT span, that the `traceparent`
  header the target received carries that span's trace and span IDs, and that spans
  carry `service.name=toy-action`
- runs a second time with `OTEL_ROLLUP_HOOKS=async` when the first run used in-thread hooks,
  so both hook paths get exercised on Node versions that support sync hooks
- builds and runs the same app without the plugin as a control: no spans, no traceparent

It prints a ✓/✗ line per check and exits non-zero on any failure.

## In CI

`.github/workflows/verify.yml` runs two jobs on every push:

- `verify`: `npm install && npm run verify` on Node 24
- `as-action`: builds, deletes every `node_modules`, starts the fake backend, then runs the
  built action with `uses: ./app`, so the runner itself launches `dist/index.js` on its
  bundled Node 24 with no node flags, exactly as it would for a published action. A last
  step checks the spans and `traceparent` headers the backend received. The action's log
  line `[otel] hooks=… node=…` shows which hook path the runner's Node version took.

## How the work is split

`otel-sdk-init` owns everything about OpenTelemetry and doesn't know about Rollup. Its
`start({ serviceName, instrumentations, hookUrl })`:

- registers import-in-the-middle's loader hooks for the modules the chosen instrumentations
  patch: in-thread `module.registerHooks()` on Node >= 22.22.3 or >= 24.11.1, otherwise
  `module.register(hookUrl)` on a hooks thread
- sets up the tracer provider, OTLP/HTTP exporter, context manager and propagators
- registers the instrumentations (`http`, `undici`)
- flushes spans on `beforeExit`

`rollup-plugin-otel` only bundles. The app's config passes `sdkOptions`, which end up as
the argument to `start()`:

```js
otel({ sdkOptions: { serviceName: 'toy-action' } })
```

| Rollup hook | Job |
| --- | --- |
| `buildStart` | Resolves the SDK package (option `sdk`, default `otel-sdk-init`) from the project, and import-in-the-middle through the SDK's `@opentelemetry/instrumentation`; emits `otel-hook.mjs`, `otel-iitm-register.mjs` and `package.json` |
| `resolveId` | Swaps each entry for `<real id>?otel-entry`, so the entry keeps its file name |
| `load` | Generates the bootstrap (`import '\0otel-init'; await import(realEntry)`) and the init module (`import { start } from 'otel-sdk-init'; start({ ...sdkOptions, hookUrl })`); serves import-in-the-middle's CommonJS registry as ESM |
| `transform` | Points import-in-the-middle's loader at the emitted registry file; rewrites CommonJS `require` shims in `node_modules` into static imports; warns if a browser build of OTel was bundled |
| `outputOptions` | Turns `output.file` into `output.dir` + the same entry file name |
| `renderStart` / `generateBundle` | Fails the build on non-ESM output, `inlineDynamicImports`, or a hook file that would load the bootstrap or SDK; warns about runtime `require()`s left in the output |

Runtime settings, read by `otel-sdk-init`: `OTEL_EXPORTER_OTLP_ENDPOINT` (default
`http://localhost:4318`), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_SERVICE_NAME`,
`OTEL_LOG_LEVEL`; `OTEL_ROLLUP_HOOKS=sync|async` forces a hook path and
`OTEL_ROLLUP_DEBUG=1` logs which one ran.

## Status

Verified in GitHub Actions against OpenTelemetry JS 3.0 (`@opentelemetry/sdk-trace`, which
replaced `sdk-trace-node`), import-in-the-middle 3.5 and Rollup 4. Both jobs pass:

- `verify` (Node 24.22): in-thread sync hooks and forced off-thread hooks both export the
  `http.get` span (instrumentation-http) and the `fetch` span (instrumentation-undici),
  each with a matching `traceparent`; the control build exports nothing
- `as-action`: the runner's own Node 24.21 runs `dist/index.js` with no `node_modules`,
  picks the sync hook path, and the collector receives both spans

What it took to get there, in case you adapt the plugin:

- Locate import-in-the-middle with Node's resolver. Going through `this.resolve()` let
  `@rollup/plugin-commonjs` load its registry as CommonJS before the plugin could serve it
  as ESM.
- OTel's ESM builds load CommonJS dependencies (e.g. `forwarded-parse`) through a
  rolldown `__require` shim imported from `_rolldown/runtime.mjs`. Rollup can't follow it,
  so the plugin rewrites literal shim calls into static imports, and warns at build time
  about any runtime `require()` of a non-builtin module left in the output
  (`optionalRequires`, default `['supports-color']`, lists known-optional ones to ignore).
- OTel 3.0 takes `new BatchSpanProcessor({ exporter })`, not the exporter as first argument.

Remaining caveats:

- The plugin depends on two details of import-in-the-middle's internals (how the loader
  computes the registry URL, and the registry's `exports.x = x` lines); it fails the build
  with a clear message if either changes.
- The entry module's own exports are not re-exported by the bootstrap. That's fine for
  actions and most apps; a library entry would need them generated from `this.load()`'s
  export list.
- `.github/scripts/annotate.sh` posts step output as annotations, so CI results are
  readable through the checks API when raw job logs aren't reachable.
