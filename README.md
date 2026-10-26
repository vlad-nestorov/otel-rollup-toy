# otel-rollup-toy: no Rollup plugin, OTel ESM builds with the shim transform

_One of several approaches, each on its own branch; `main` compares them._

This branch is `sdk-esm-shim-transform` without the `rollup-plugin-otel` package. The app starts
OpenTelemetry itself with one import, the output is still one self-contained bundle, and
the spans come from the same stock OTel instrumentations. Compare with `sdk-esm-shim-transform` and with the `option-1-externalize`,
`option-2-code-transformer` and `option-3-virtual-wrapper` branches.

```
sdk/   otel-sdk-init: start() sets up the SDK, enables the stock http and undici
       instrumentations, patches node:http/node:https in place, flushes on exit
app/   toy action: src/index.js imports src/otel.js first, which calls start()
```

## Why the plugin isn't needed

Most of what `sdk-esm-shim-transform`'s plugin does exists to make import-in-the-middle's loader hooks
work from inside a bundle: the bootstrap that loads the app after the hooks are
registered, the emitted hook file, the shared registry file, and the rewrite that points
the loader at it. But when everything is bundled, the only modules a loader hook ever
sees are Node's builtins, and a builtin's CommonJS exports object is the one object every
import of it shares. So `start()` hands `node:http` and `node:https` straight to the stock
`HttpInstrumentation`'s own patch function, the call a loader hook would have made, and
then calls `syncBuiltinESMExports()` so named imports see the patch too. fetch is covered
by `UndiciInstrumentation` through diagnostics channels, as before.

Without loader hooks, `start()` only has to run before the action's first call, not
before its modules load. So no bootstrap or dynamic import is needed: `src/otel.js` calls
`start({ serviceName: 'toy-action' })`, and `src/index.js` imports it first. Static imports
evaluate in order, so the SDK starts before any other module of the action runs.

## What's left in the build config

`app/rollup.config.js` has one OTel-specific piece: an inline `transform` hook,
`bundleRequireShims`, documented at the top of the file. It's the same fix `sdk-esm-shim-transform`'s plugin
applies.

**The problem it solves.** `@opentelemetry/instrumentation-http` imports the CommonJS
package `forwarded-parse` with TypeScript's `import forwardedParse = require('forwarded-parse')`.
OTel's build (tsdown, on rolldown) keeps that a real `require()` in the ESM output, through a
shim built with `createRequire`:

```js
// dist/_virtual/_rolldown/runtime.mjs
import { createRequire } from "node:module";
var __require = /* #__PURE__ */ (() => createRequire(import.meta.url))();
export { __require };

// dist/utils.mjs
import { __require } from "./_virtual/_rolldown/runtime.mjs";
const forwardedParse = __require("forwarded-parse");
```

To Rollup, `__require` is just an imported function, so `forwarded-parse` isn't bundled and
the call runs at runtime, resolving from the bundle's own location. Inside the repo it finds
`node_modules` and works by accident; deployed without them, the action crashes with
"Cannot find module 'forwarded-parse'".

**What the transform does.** In files under `node_modules`, each call through such a shim
with a string-literal, non-builtin specifier becomes a static import that Rollup bundles:

```js
import * as __otel_cjs_0 from "forwarded-parse";
const __otel_interop = (m) => (m && m.default !== undefined ? m.default : m);
const forwardedParse = __otel_interop(__otel_cjs_0);
```

`@rollup/plugin-commonjs` exposes `module.exports` as the default export, which the interop
returns: the value `require()` would have returned. Builtins keep their runtime call, and
`verify` fails if any non-builtin module is still required at runtime.

**Limits.** Only string-literal specifiers are rewritten. It assumes the required module is
CommonJS. The import runs when the importing module is evaluated rather than at the call,
which for a top-level import-equals is the same moment.

**Why not `exportConditions: ['node', 'require']`.** That picks OTel's CommonJS builds,
whose plain `require()` calls `@rollup/plugin-commonjs` does bundle. But CommonJS can't be
tree-shaken. Measured on this action:

| Approach | Bundle | Runs without `node_modules` |
| --- | --- | --- |
| ESM builds, no transform | 312 KB | no: `forwarded-parse` is required at runtime |
| ESM builds + this transform | 320 KB | yes |
| `exportConditions: ['node', 'require']` | 1,018 KB | yes |

These were measured before the toy used the real `@actions/core` and exported logs; `main`
has current sizes. Most of the CommonJS build's extra size is `@opentelemetry/semantic-conventions` (285 KB)
and `sdk-metrics` (145 KB), which the ESM build drops. The real fix is upstream: OTel could
enable rolldown's
[`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require) for
`forwarded-parse`, or use a default import with `esModuleInterop`.

The output is a single `dist/index.js`, so `action.yml` and `output.file` stay as they were.

## Limits compared with the plugin

- Only builtins are instrumented this way. A library that stays external and loads from
  `node_modules` at runtime would need the loader hooks again (see `option-1-externalize`);
  a bundled third-party library needs option 2 or 3.
- Code that grabs a builtin function before `start()` runs (e.g. `const get = http.get` at
  the top of a module evaluated first) keeps the unpatched one. Keeping `./otel.js` the
  first import of the entry avoids that for the action's own code.

## GitHub Actions: service name and logs

`start()` takes `service.name` from the action's `otel-service-name` input at runtime,
then from `OTEL_SERVICE_NAME`, then from its `serviceName` option. `action.yml` declares
the input without a default, so the fallbacks can apply.

It also exports what the action logs through `@actions/core` as OTLP log records, to
`/v1/logs` (or `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT`). `@actions/core` writes every log call
to stdout, so `sdk/actions.js` watches `process.stdout`:

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

```sh
npm install
npm run verify
```

`verify` builds the action, checks the bundle is one file with `start()` ahead of the
action's code and nothing left to `require()` at runtime, runs it from a temp folder with no `node_modules` against a local fake
collector, and checks that `http.get` and `fetch` exported spans whose IDs match the
`traceparent` each request carried. It also checks that `core.info()` and `core.debug()`
were exported as log records, that none contains the `api-token` the action registered as a
secret, and that spans and records carry `service.name`, taken from the
`otel-service-name` input in a second run. The control build swaps `src/otel.js` for an
empty module and must export nothing.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs `uses: ./app` with every
`node_modules` deleted, so the GitHub runner launches the bundle on its own Node 24.
That run passes the `otel-service-name` and `api-token` inputs, plus an
`OTEL_SERVICE_NAME` the input has to override.
