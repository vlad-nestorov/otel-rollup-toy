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
