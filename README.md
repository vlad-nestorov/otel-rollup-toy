# otel-rollup-toy: Rollup plugin, SDK prebundled as CommonJS

_One of several approaches, each on its own branch; `main` compares them._

A Rollup plugin and an SDK package that add OpenTelemetry auto-instrumentation to an ESM
build, plus a toy GitHub JavaScript action that uses them without any OTel code in its source.

> **Branch `sdk-prebundled-cjs`:** `otel-sdk-init` is prebundled from OpenTelemetry's
> CommonJS builds, so the plugin no longer rewrites the `createRequire` shim. It works, but
> OpenTelemetry's share of the action's output grows from 492 KB on `sdk-esm-shim-transform`
> to 1,159 KB; see [The createRequire shim](#the-createrequire-shim).

```
plugin/   rollup-plugin-otel: the Rollup part only, no OpenTelemetry dependencies
sdk/      otel-sdk-init: start() sets up loader hooks, the SDK, instrumentations and flushing;
          builds itself into dist/index.cjs with its OTel dependencies bundled
app/      toy action: depends on otel-sdk-init; src/ has no OTel code; rollup.config.js adds otel()
```

## GitHub Actions: service name and logs

`start()` takes `service.name` from the action's `otel-service-name` input at runtime,
then from `OTEL_SERVICE_NAME`, then from its `serviceName` option. `action.yml` declares
the input without a default, so the fallbacks can apply.

It also exports what the action logs through `@actions/core` as OTLP log records, to
`/v1/logs` (or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`). `@actions/core` writes every log call
to stdout, so `sdk/src/actions.js` watches `process.stdout`:

- plain lines, which is what `core.info()` and `console.log()` write, become INFO records
- `::debug::`, `::notice::`, `::warning::` and `::error::` (`core.setFailed()` writes the
  last) become records of that severity, with annotation properties such as `file` and
  `line` as `actions.annotation.*` attributes
- other workflow commands (groups, outputs, state) are skipped
- values registered with `core.setSecret()` are replaced by `***`, as in the runner's log

This works the same however `@actions/core` is bundled, and it catches the calls
`@actions/core` makes internally, which patching its exports would miss. Two things differ
from the runner's own log: debug records are exported even when step debug logging is off,
and a secret the runner masks but the action never registered with `core.setSecret()` (an
input filled from `secrets.*`, say) is exported as is. `actionsLogs: false` in `start()`'s
options turns the capture off. OTel's own diagnostics go to stderr, so they're never
captured.

The toy action uses the real `@actions/core`, and logs an `api-token` input at debug level
after registering it as a secret, so the checks can confirm that no exported record
contains it.

## Run it

Needs Node 22 or later.

```sh
npm install
npm run verify
```

`verify` builds `otel-sdk-init`, then the action, copies `dist/` to a temp folder with no `node_modules`
(like an action checkout on a runner), runs it against a local fake collector, then:

- checks the build output: `index.js` (bootstrap), `otel-hook.mjs` (loader hook),
  `otel-iitm-register.mjs` (import-in-the-middle registry), `package.json` (type: module),
  that the app code is loaded with a dynamic `import()` rather than inlined in the entry,
  and that no non-builtin module is left to `require()` at runtime
- checks that `http.get` and `fetch` each exported a CLIENT span, that the `traceparent`
  header the target received carries that span's trace and span IDs, and that spans
  carry `service.name=toy-action`
- checks that `core.info()` and `core.debug()` were exported as log records, that none
  contains the `api-token` the action registered as a secret, and that they carry the same
  `service.name`
- runs a second time with `OTEL_ROLLUP_HOOKS=async` and the `otel-service-name` input set
  when the first run used in-thread hooks, so both hook paths get exercised on Node versions
  that support sync hooks
- builds and runs the same app without the plugin as a control: no spans, no traceparent,
  no log records

It prints a ✓/✗ line per check and exits non-zero on any failure.

## In CI

`.github/workflows/verify.yml` runs two jobs on every push:

- `verify`: `npm install && npm run verify` on Node 24
- `as-action`: builds, deletes every `node_modules`, starts the fake backend, then runs the
  built action with `uses: ./app`, so the runner itself launches `dist/index.js` on its
  bundled Node 24 with no node flags, exactly as it would for a published action. The action
  gets `otel-service-name` and `api-token` inputs, plus an `OTEL_SERVICE_NAME` the input has
  to override, and a last step checks the spans, `traceparent` headers and log records the
  backend received. The action's log
  line `[otel] hooks=… node=…` shows which hook path the runner's Node version took.

## How the work is split

`otel-sdk-init` owns everything about OpenTelemetry and doesn't know about the app's
bundler. It ships as one prebundled CommonJS file, `dist/index.cjs` (built by
`sdk/rollup.config.js`), with `import-in-the-middle` as its only dependency. Its
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
| `buildStart` | Resolves the SDK package (option `sdk`, default `otel-sdk-init`) from the project, and import-in-the-middle from the SDK package; emits `otel-hook.mjs`, `otel-iitm-register.mjs` and `package.json` |
| `resolveId` | Swaps each entry for `<real id>?otel-entry`, so the entry keeps its file name |
| `load` | Generates the bootstrap (`import '\0otel-init'; await import(realEntry)`) and the init module (`import { start } from 'otel-sdk-init'; start({ ...sdkOptions, hookUrl })`); serves import-in-the-middle's CommonJS registry as ESM |
| `transform` | Points import-in-the-middle's loader at the emitted registry file |
| `outputOptions` | Turns `output.file` into `output.dir` + the same entry file name |
| `renderStart` / `generateBundle` | Fails the build on non-ESM output, `inlineDynamicImports`, or a hook file that would load the bootstrap or SDK; warns about runtime `require()`s left in the output |

Runtime settings, read by `otel-sdk-init`: `OTEL_EXPORTER_OTLP_ENDPOINT` (default
`http://localhost:4318`), `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`,
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`, `OTEL_SERVICE_NAME` (after the `otel-service-name`
input), `OTEL_LOG_LEVEL`; `OTEL_ROLLUP_HOOKS=sync|async` forces a hook path and
`OTEL_ROLLUP_DEBUG=1` logs which one ran.

## The createRequire shim

One OTel dependency doesn't bundle from OTel's ESM builds. `sdk-esm-shim-transform` fixes that with a
transform in the plugin; this branch avoids it by building `otel-sdk-init` from the
CommonJS builds first.

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

**What this branch does.** `sdk/rollup.config.js` bundles `otel-sdk-init` with
`exportConditions: ['node', 'require']`, which picks OTel's CommonJS builds. Their plain
`require("forwarded-parse")` is something `@rollup/plugin-commonjs` bundles, so the app's
build only ever sees one CommonJS file and the plugin needs no shim handling.
`import-in-the-middle` stays external: the plugin emits its loader hook and registry as
separate files, and the instrumentations' `Hook()` calls must register with that same
registry, so the app's build has to bundle the one copy the SDK requires.

**What it costs, measured in CI.** The toy action's output, and OpenTelemetry's share of
it: the output minus the same action built without OpenTelemetry (966 KB, nearly all of it
`@actions/core` and what it pulls in):

| | `sdk-esm-shim-transform` (ESM builds + shim transform) | this branch (CommonJS prebundle) |
| --- | --- | --- |
| Action output | 1,458 KB | 2,125 KB |
| OpenTelemetry's share | 492 KB | 1,159 KB |

CommonJS can't be tree-shaken, so the prebundle carries all of
`@opentelemetry/semantic-conventions` (285 KB; 16 KB from the ESM builds) and `sdk-metrics`
(128 KB; not in the ESM builds' output at all), which the CommonJS build of
`otlp-transformer` pulls in, plus 69 KB of `otlp-transformer`. With `commonjs()`'s default
`strictRequires` every module is wrapped in a function, which cost another 70 KB when it was
measured; `strictRequires: 'auto'` avoids that.

**Other alternatives, measured earlier**, before the toy used the real `@actions/core`.
These are single-file bundles of the action without the loader-hook files (as on the `sdk-esm-shim-transform-no-plugin` branch):

| Approach | Bundle | Runs without `node_modules` |
| --- | --- | --- |
| ESM builds, no transform | 312 KB | no: `forwarded-parse` is required at runtime |
| ESM builds + the shim transform | 320 KB | yes |
| `exportConditions: ['node', 'require']` in the app's build (all CommonJS builds) | 1,018 KB | yes |
| Only `instrumentation-http` aliased to its CommonJS build | 816 KB | yes |

Prebundling the SDK as CommonJS ends up in the same range as using the CommonJS builds in
the app's own build: the cost comes from the CommonJS builds themselves, not from where
they get bundled.

The fix belongs upstream: OTel could enable rolldown's
[`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require) for
`forwarded-parse`, or import it as a default import with `esModuleInterop` on. Either would
make the ESM build bundle as is.

## Status

Verified in GitHub Actions against OpenTelemetry JS 3.0 (`@opentelemetry/sdk-trace`, which
replaced `sdk-trace-node`), import-in-the-middle 3.5 and Rollup 4. Both jobs pass:

- `verify` (Node 24.22): in-thread sync hooks and forced off-thread hooks both export the
  `http.get` span (instrumentation-http) and the `fetch` span (instrumentation-undici),
  each with a matching `traceparent`, plus the action's `@actions/core` output as log
  records; the control build exports nothing
- `as-action`: the runner's own Node 24.21 runs `dist/index.js` with no `node_modules`,
  picks the sync hook path, and the collector receives both spans and the log records,
  under the `service.name` from the `otel-service-name` input

What it took to get there, in case you adapt the plugin:

- Locate import-in-the-middle with Node's resolver. Going through `this.resolve()` let
  `@rollup/plugin-commonjs` load its registry as CommonJS before the plugin could serve it
  as ESM.
- OTel's ESM builds load `forwarded-parse` through a rolldown `createRequire` shim that
  Rollup can't follow; this branch prebundles the SDK from the CommonJS builds instead
  (see "The createRequire shim" above). The plugin still warns about any runtime
  `require()` left in the output; `optionalRequires`, default `['supports-color']`, lists
  requires that are meant to fail quietly and stay out of that warning.
- OTel 3.0 takes `new BatchSpanProcessor({ exporter })`, not the exporter as first argument,
  and `BatchLogRecordProcessor` the same way. Its logs API is part of `@opentelemetry/api`
  1.10 now.

Remaining caveats:

- `otel-sdk-init` has to be built before the app (`dist/` isn't committed); the root
  `build` and `verify` scripts do that.
- An app that imports `@opentelemetry/api` itself gets its own copy next to the one inside
  the prebundle. The API's global registry keeps the two connected, but the code ships
  twice.

- The plugin depends on two details of import-in-the-middle's internals (how the loader
  computes the registry URL, and the registry's `exports.x = x` lines); it fails the build
  with a clear message if either changes.
- The entry module's own exports are not re-exported by the bootstrap. That's fine for
  actions and most apps; a library entry would need them generated from `this.load()`'s
  export list.
- `.github/scripts/annotate.sh` posts step output as annotations, so CI results are
  readable through the checks API when raw job logs aren't reachable.
