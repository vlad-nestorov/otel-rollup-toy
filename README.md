# otel-rollup-toy: option 1, keep dependencies external

_One of several approaches, each on its own branch; `main` compares them._

This branch shows `otel-sdk-init` used without a dedicated Rollup plugin, by keeping the
instrumented libraries (and the SDK itself) out of the bundle. Compare with `sdk-esm-shim-transform`,
where `rollup-plugin-otel` makes the same SDK work with everything bundled, and with the
`option-2-code-transformer` and `option-3-virtual-wrapper` branches.

```
sdk/   otel-sdk-init: start() registers import-in-the-middle's loader hooks, the SDK and
       the stock OTel instrumentations for http, fetch (undici) and dataloader
app/   toy action: src/main.js calls start() then imports src/index.js, which uses
       node:http, fetch and dataloader
```

## How it works

- `app/rollup.config.js` marks every runtime dependency external (`otel-sdk-init`,
  `dataloader`). The bundle holds only the app's own code and imports those packages
  from `node_modules` at runtime.
- `src/main.js` calls `start()` before importing the action, so the loader hooks exist
  before Node loads `dataloader`. On Node >= 22.22.3 / >= 24.11.1 the hooks run in-thread;
  otherwise `start()` registers import-in-the-middle's own `hook.mjs` from `node_modules`.
- When the action imports `dataloader`, the hooks hand it to the stock
  `@opentelemetry/instrumentation-dataloader`, which replaces its constructor and patches
  its prototype. `node:http` goes through the same hooks to `@opentelemetry/instrumentation-http`;
  fetch is covered by `@opentelemetry/instrumentation-undici` through diagnostics channels.

## Trade-offs

- No build-time instrumentation code at all: any stock OTel instrumentation works as-is.
- The action must ship a production `node_modules` (for an action repo: commit it), which
  gives up most of what bundling was for. `app/scripts/deploy.mjs` builds that layout.
- Anything that ends up bundled is invisible to the hooks. Mark every instrumented library
  external, including when another dependency is the one that imports it.

## Run it

```sh
npm install
npm run verify
```

`verify` builds the action, deploys it to a temp folder with `action.yml`, `dist/` and a
production `node_modules`, runs it against a local fake collector, and checks that
`http.get`, `fetch` and `dataloader.load` exported spans, that each request's
`traceparent` matches its span, and that a build without OpenTelemetry exports nothing.
On Node versions with in-thread hooks it runs a second time with `OTEL_ROLLUP_HOOKS=async`.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs the deployed copy with
`uses: ./deployed-action` so the GitHub runner launches it on its own Node 24.
