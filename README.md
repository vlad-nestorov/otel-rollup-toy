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

`verify` builds the action, deploys it to a temp folder with `action.yml`, `dist/` and a
production `node_modules`, runs it against a local fake collector, and checks that
`http.get`, `fetch` and `dataloader.load` exported spans, that each request's
`traceparent` matches its span, that `core.info()` and `core.debug()` were exported as log
records without the `api-token` the action registered as a secret, and that a build without
OpenTelemetry exports nothing.
A second run takes `service.name` from the `otel-service-name` input and, on Node versions
with in-thread hooks, forces `OTEL_ROLLUP_HOOKS=async`.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs the deployed copy with
`uses: ./deployed-action` so the GitHub runner launches it on its own Node 24.
That run passes the `otel-service-name` and `api-token` inputs, plus an
`OTEL_SERVICE_NAME` the input has to override.
