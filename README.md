# otel-rollup-toy: main without the Rollup plugin

This branch is `main` without the `rollup-plugin-otel` package. The app starts
OpenTelemetry itself with one import, the output is still one self-contained bundle, and
the spans come from the same stock OTel instrumentations. Compare with `main` and with the `option-1-externalize`,
`option-2-code-transformer` and `option-3-virtual-wrapper` branches.

```
sdk/   otel-sdk-init: start() sets up the SDK, enables the stock http and undici
       instrumentations, patches node:http/node:https in place, flushes on exit
app/   toy action: src/index.js imports src/otel.js first, which calls start()
```

## Why the plugin isn't needed

Most of what `main`'s plugin does exists to make import-in-the-middle's loader hooks
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

`app/rollup.config.js` is a plain config. The one OTel-related setting is
`exportConditions: ['node', 'require']`, which picks OTel's CommonJS builds. Their ESM builds load some CommonJS dependencies (e.g. `forwarded-parse`) through a
`createRequire` shim Rollup can't follow, which `main`'s plugin rewrites; the CommonJS
builds use plain `require()`, which `@rollup/plugin-commonjs` bundles. The cost is size:
CommonJS can't be tree-shaken, so the bundle grows from about 312 KB to about 1,018 KB,
mostly `@opentelemetry/semantic-conventions` (285 KB) and `sdk-metrics` (145 KB) that the
ESM build would drop. `main`'s plugin keeps the ESM builds and rewrites the one shim call
into a static import instead.

The output is a single `dist/index.js`, so `action.yml` and `output.file` stay as they were.

## Limits compared with main

- Only builtins are instrumented this way. A library that stays external and loads from
  `node_modules` at runtime would need the loader hooks again (see `option-1-externalize`);
  a bundled third-party library needs option 2 or 3.
- Code that grabs a builtin function before `start()` runs (e.g. `const get = http.get` at
  the top of a module evaluated first) keeps the unpatched one. Keeping `./otel.js` the
  first import of the entry avoids that for the action's own code.

## Run it

```sh
npm install
npm run verify
```

`verify` builds the action, checks the bundle is one file with `start()` ahead of the
action's code, runs it from a temp folder with no `node_modules` against a local fake
collector, and checks that `http.get` and `fetch` exported spans whose IDs match the
`traceparent` each request carried. The control build swaps `src/otel.js` for an empty
module and must export nothing.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs `uses: ./app` with every
`node_modules` deleted, so the GitHub runner launches the bundle on its own Node 24.
