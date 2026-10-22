# otel-rollup-toy: option 2, build-time code transformer

This branch shows `otel-sdk-init` used without a dedicated Rollup plugin, by rewriting
the instrumented library's source at build time with the off-the-shelf
`@apm-js-collab/code-transformer-bundler-plugins` (orchestrion). Compare with `main`,
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

## Run it

```sh
npm install
npm run verify
```

`verify` builds the action, deploys `action.yml` and `dist/` to a temp folder with no
`node_modules`, runs it against a local fake collector, and checks that `http.get`,
`fetch` and `dataloader.load` exported spans, that each request's `traceparent` matches
its span, and that a build without OpenTelemetry exports nothing.

CI (`.github/workflows/verify.yml`) runs `verify`, and also runs the deployed copy with
`uses: ./deployed-action` so the GitHub runner launches it on its own Node 24.
