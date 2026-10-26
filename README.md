# otel-rollup-toy: option 3, build-time wrapper modules

_One of several approaches, each on its own branch; `main` compares them._

This branch shows `otel-sdk-init` used without a dedicated Rollup plugin package, by
routing imports of instrumented libraries through generated wrapper modules: a few lines
of inline hooks in `app/rollup.config.js`. Compare with `sdk-esm-shim-transform`, where
`rollup-plugin-otel` makes the hook-based SDK work bundled, and with the
`option-1-externalize` and `option-2-code-transformer` branches.

```
sdk/   otel-sdk-init
         index.js     start(): tracer provider, exporter, instrumentations, flush on exit;
                      instrumentModule(): applies stock OTel patches to a handed-over module
         channels.js  http client spans from Node's http diagnostics channels
app/   toy action: src/main.js calls start() then imports src/index.js, which uses
       node:http, fetch and dataloader
```

## How it works

- `app/rollup.config.js` resolves `import ... from 'dataloader'` to a virtual module that
  imports the real dataloader and exports
  `instrumentModule('dataloader', '<version read at build time>', module.exports)`.
- `instrumentModule()` finds the stock `@opentelemetry/instrumentation-dataloader`'s module
  definition through `getModuleDefinitions()`, checks the version against its supported
  range, and runs its `patch()`: the same call import-in-the-middle would make when Node
  loads the package. The patch replaces the constructor and wraps the prototype, and the
  wrapper exports the patched constructor.
- `node:http` gets spans from Node's built-in http client channels and fetch from the
  stock undici instrumentation, so no loader hooks are involved anywhere and the SDK is
  bundled with the action. `dist/` is self-contained.
- `src/main.js` calls `start()` before importing the action, because the wrapper patches
  when it is evaluated. A library loaded before `start()` is reported and left alone.

## Trade-offs

- Reuses the stock OTel instrumentations and their spans unchanged, without shipping
  `node_modules`.
- Wraps the boundary between the app and the library only. Prototype patches like
  dataloader's reach every instance; a patch that replaces a function only affects calls
  that go through the wrapper, not calls inside the library.
- This wrapper handles CommonJS libraries whose API is their `module.exports`. Named ESM
  exports, `export *` and instrumentations that patch internal files need more generated
  code (see `sdk-esm-shim-transform`'s plugin for the general version through import-in-the-middle).
- OTel's http instrumentation isn't used here: its ESM build loads `forwarded-parse`
  through a `require` shim that Rollup can't bundle without a plugin to rewrite it.

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

`verify` builds the action, deploys `action.yml` and `dist/` to a temp folder with no
`node_modules`, runs it against a local fake collector, and checks that `http.get`,
`fetch` and `dataloader.load` exported spans, that each request's `traceparent` matches
its span, that `core.info()` and `core.debug()` were exported as log
records without the `api-token` the action registered as a secret, and that a build without
OpenTelemetry exports nothing. A second run checks that spans and
records take `service.name` from the `otel-service-name` input.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs the deployed copy with
`uses: ./deployed-action` so the GitHub runner launches it on its own Node 24.
That run passes the `otel-service-name` and `api-token` inputs, plus an
`OTEL_SERVICE_NAME` the input has to override.
