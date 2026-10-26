# otel-rollup-toy: option 2, build-time code transformer

_One of several approaches, each on its own branch; `main` compares them._

This branch shows `otel-sdk-init` used without a dedicated Rollup plugin, by rewriting
the instrumented library's source at build time with the off-the-shelf
`@apm-js-collab/code-transformer-bundler-plugins` (orchestrion). Compare with `sdk-esm-shim-transform`,
where `rollup-plugin-otel` makes the patch-based SDK work bundled, and with the
`option-1-externalize` and `option-3-virtual-wrapper` branches.

```
sdk/   otel-sdk-init
         transforms.js  build-time configs: which library functions get TracingChannels
         channels.js    runtime subscribers: http (Node's channels), dataloader (injected ones)
         index.js       start(): tracer provider, exporter, subscribers, flush on exit
app/   toy action: src/main.js calls start() then imports src/index.js, which uses
       node:http, fetch and dataloader
```

## How it works

- `app/rollup.config.js` adds the code-transformer plugin with `codeTransforms` from
  `otel-sdk-init/transforms`. As dataloader is bundled, the plugin wraps its `load`
  function in a `tracingChannel('orchestrion:dataloader:load')` call. It runs before
  `@rollup/plugin-commonjs` so it sees the original CommonJS source.
- At runtime `start()` subscribes to that channel and turns its `start`/`asyncEnd`/`error`
  events into `dataloader.load` spans.
- `node:http` gets spans from Node's built-in `http.client.request.created` /
  `http.client.response.finish` channels, which also lets the subscriber add `traceparent`
  before the request is sent. fetch is covered by the stock undici instrumentation, which
  is channel-based too.
- Nothing is patched and there are no loader hooks, so the SDK is bundled like any other
  code and `dist/` is self-contained. `start()` only has to run before the first
  instrumented call; `src/main.js` keeps the dynamic import anyway, for a single pattern.

## Trade-offs

- Edits library internals rather than exports, so it survives bundling, frozen exports and
  internal call sites. The same approach also works in Bun, Deno and Cloudflare Workers.
- Each library needs a transform config pinned to its file layout and function names
  (`index.js`, `load` for dataloader 2.x), and a subscriber to turn channel events into
  spans. The stock OTel instrumentations can't be reused as they are.
- For builtins it relies on the channels Node publishes, which cover less than OTel's
  http instrumentation does today (this toy only does client spans).

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
