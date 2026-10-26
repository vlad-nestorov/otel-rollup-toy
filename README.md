# otel-rollup-toy: Rollup plugin, OTel ESM builds with the shim transform

_One of several approaches, each on its own branch; `main` compares them._

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
  that the app code is loaded with a dynamic `import()` rather than inlined in the entry,
  and that no non-builtin module is left to `require()` at runtime
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

## The createRequire shim

One OTel dependency doesn't bundle on its own. The plugin's `transform` hook fixes it; the
full explanation is also in `plugin/index.js` under "CommonJS dependencies loaded through
a createRequire shim".

**Where it comes from.** `@opentelemetry/instrumentation-http` imports the CommonJS
package `forwarded-parse` with TypeScript's import-equals syntax:

```ts
import forwardedParse = require('forwarded-parse');
```

OTel builds with tsdown, which uses rolldown. For dependencies it doesn't bundle, rolldown
keeps `require()` semantics in Node ESM output by building a real `require` with
`createRequire`, instead of turning the call into an `import`. The published files
(0.300.0) differ by format:

```js
// dist/_virtual/_rolldown/runtime.mjs
import { createRequire } from "node:module";
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
export { __require };

// dist/utils.mjs (ESM build)
import { __require } from "./_virtual/_rolldown/runtime.mjs";
const forwardedParse = __require("forwarded-parse");

// dist/utils.cjs (CommonJS build)
const forwardedParse = require("forwarded-parse");
```

**Why Rollup doesn't bundle it.** `@rollup/plugin-commonjs` rewrites the free `require` of
CommonJS modules. In the ESM file `__require` is just a function imported from another
module, so Rollup leaves the call in the output and `forwarded-parse` is never bundled.

**What goes wrong.** After bundling, `import.meta.url` is the bundle's own URL, so the call
resolves `forwarded-parse` starting from `dist/`. Run inside the repo, it finds the repo's
`node_modules` and works by accident. Deployed without `node_modules`, the action crashes
with "Cannot find module 'forwarded-parse'". (Checked in CI, both ways.)

**What the plugin does.** In files under `node_modules`, every call through such a shim
with a string-literal, non-builtin specifier becomes a static import:

```js
import * as __otel_cjs_0 from "forwarded-parse";
const __otel_interop = (m) => (m && m.default !== undefined ? m.default : m);
const forwardedParse = __otel_interop(__otel_cjs_0);
```

`@rollup/plugin-commonjs` exposes a CommonJS module's `module.exports` as its default
export, which `__otel_interop` returns: the same value `require()` would have. The shim is
then unused and tree-shaken away. It finds shims both when they're imported from rolldown's
runtime module (as published) and when a file declares one itself.

**Limits.**

- Only string-literal specifiers. `generateBundle` warns about any runtime `require()` of a
  non-builtin module still in the output, and `verify` fails on one.
- Builtins (`node:http`, `fs`, ...) keep the runtime call; Node always has them.
- It assumes the required module is CommonJS. `require()` of an ES module returns its
  namespace, while the interop returns its default export when it has one.
- The import runs when the importing module is evaluated, not at the call. For a
  top-level import-equals, as in OTel, that's the same moment.

**Alternatives, measured on this toy.** These are single-file bundles of the action without
the loader-hook files (as on the `sdk-esm-shim-transform-no-plugin` branch), so the approaches compare
directly; this branch's own output is 450 KB in total because it also ships the hook files.

| Approach | Bundle | Runs without `node_modules` |
| --- | --- | --- |
| ESM builds, no transform | 312 KB | no: `forwarded-parse` is required at runtime |
| ESM builds + this transform | 320 KB | yes |
| `exportConditions: ['node', 'require']` (all CommonJS builds) | 1,018 KB | yes |
| Only `instrumentation-http` aliased to its CommonJS build | 816 KB | yes |

The CommonJS builds use plain `require()`, which `@rollup/plugin-commonjs` bundles, but
CommonJS can't be tree-shaken: most of the extra size is
`@opentelemetry/semantic-conventions` (285 KB) and `sdk-metrics` (145 KB), which the ESM
build drops. Aliasing just one package still pulls the CommonJS copies of its own
dependencies in next to the ESM ones.

The fix belongs upstream: OTel could enable rolldown's
[`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require) for
`forwarded-parse`, or import it as a default import with `esModuleInterop` on. Either would
make the ESM build bundle as is.

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
- OTel's ESM builds load `forwarded-parse` through a rolldown `createRequire` shim that
  Rollup can't follow; the plugin rewrites the call into a static import (see "The
  createRequire shim" above). `optionalRequires`, default `['supports-color']`, lists
  requires that are meant to fail quietly and stay out of the build warning.
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
