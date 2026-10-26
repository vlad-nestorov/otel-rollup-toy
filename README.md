# otel-rollup-toy: no Rollup plugin, SDK prebundled as CommonJS

_One of several approaches, each on its own branch; `main` compares them._

This branch is `sdk-esm-shim-transform-no-plugin` with `otel-sdk-init` prebundled from OpenTelemetry's
CommonJS builds, the way `sdk-prebundled-cjs` does it for `sdk-esm-shim-transform`. The app starts
OpenTelemetry itself with one import, its Rollup config has nothing OTel-specific in it,
and the output is still one self-contained bundle. The cost is size: 972 KB instead of
`sdk-esm-shim-transform-no-plugin`'s 320 KB (see [Size](#size)).

```
sdk/   otel-sdk-init: start() sets up the SDK, enables the stock http and undici
       instrumentations, patches node:http/node:https in place, flushes on exit;
       builds itself into dist/index.cjs with its OTel dependencies bundled
app/   toy action: src/index.js imports src/otel.js first, which calls start();
       rollup.config.js is nodeResolve() and commonjs()
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

## The build config

`app/rollup.config.js` is a plain action build:

```js
export default {
  input: 'src/index.js',
  output: { file: 'dist/index.js', format: 'es' },
  plugins: [nodeResolve({ exportConditions: ['node'], preferBuiltins: true }), commonjs()],
}
```

On `sdk-esm-shim-transform-no-plugin` it also needs an inline `transform` hook, because one OTel
dependency doesn't bundle from OTel's ESM builds. `@opentelemetry/instrumentation-http`
imports the CommonJS package `forwarded-parse` with TypeScript's
`import forwardedParse = require('forwarded-parse')`, and OTel's build (tsdown, on rolldown)
keeps that a real `require()` in the ESM output, through a shim built with `createRequire`:

```js
// dist/utils.mjs (ESM build)
import { __require } from "./_virtual/_rolldown/runtime.mjs";
const forwardedParse = __require("forwarded-parse");

// dist/utils.cjs (CommonJS build)
const forwardedParse = require("forwarded-parse");
```

To Rollup, `__require` is just an imported function, so `forwarded-parse` isn't bundled and
the action crashes with "Cannot find module 'forwarded-parse'" once deployed without
`node_modules`.

Here `sdk/rollup.config.js` bundles `otel-sdk-init` with
`exportConditions: ['node', 'require']`, which picks the CommonJS builds. Their plain
`require()` is something `@rollup/plugin-commonjs` bundles, so the SDK arrives as one
CommonJS file with everything in it, and the app's build treats it like any other
dependency. `verify` still fails if any non-builtin module is left to `require()` at runtime.

## Size

CommonJS can't be tree-shaken, so the prebundle carries all of
`@opentelemetry/semantic-conventions` (285 KB, against 16 KB from the ESM build) and
`sdk-metrics` (about 130 KB, which the CommonJS build of `otlp-transformer` pulls in and the
ESM build doesn't include at all). Measured in CI, all with the same OTel versions:

| Branch | SDK | Rollup plugin | Action output |
| --- | --- | --- | --- |
| `sdk-esm-shim-transform-no-plugin` | ESM builds + inline transform in the app's config | no | 320 KB |
| this branch | CommonJS prebundle | no | 972 KB |
| `sdk-esm-shim-transform` | ESM builds + transform in the plugin | yes | 451 KB |
| `sdk-prebundled-cjs` | CommonJS prebundle | yes | 1,105 KB |

The branches with the plugin also ship import-in-the-middle's loader (128 KB) for its
loader hooks; the ones without it patch the builtins in place and don't need it.

The real fix is upstream: OTel could enable rolldown's
[`esmExternalRequirePlugin`](https://rolldown.rs/builtin-plugins/esm-external-require) for
`forwarded-parse`, or use a default import with `esModuleInterop`. Then the ESM builds
would bundle as is, with no transform and no CommonJS cost.

## Limits compared with the plugin

- Only builtins are instrumented this way. A library that stays external and loads from
  `node_modules` at runtime would need the loader hooks again (see `option-1-externalize`);
  a bundled third-party library needs option 2 or 3.
- `otel-sdk-init` has to be built before the app (`dist/` isn't committed); the root
  `build` and `verify` scripts do that.
- An app that imports `@opentelemetry/api` itself gets its own copy next to the one inside
  the prebundle. The API's global registry keeps the two connected, but the code ships
  twice.
- Code that grabs a builtin function before `start()` runs (e.g. `const get = http.get` at
  the top of a module evaluated first) keeps the unpatched one. Keeping `./otel.js` the
  first import of the entry avoids that for the action's own code.

## Run it

```sh
npm install
npm run verify
```

`verify` builds `otel-sdk-init`, then the action, checks the bundle is one file with `start()` ahead of the
action's code and nothing left to `require()` at runtime, runs it from a temp folder with no `node_modules` against a local fake
collector, and checks that `http.get` and `fetch` exported spans whose IDs match the
`traceparent` each request carried. The control build swaps `src/otel.js` for an empty
module and must export nothing.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs `uses: ./app` with every
`node_modules` deleted, so the GitHub runner launches the bundle on its own Node 24.
