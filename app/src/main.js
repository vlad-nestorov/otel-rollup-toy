// The action's entry: start OpenTelemetry, then load the action itself.
// Without a dedicated Rollup plugin to generate this bootstrap, the app owns these lines.
import { start } from 'otel-sdk-init'

start({ serviceName: 'toy-action', instrumentations: ['http', 'undici', 'dataloader'] })

// A dynamic import, so none of the action's modules load before start() has run.
await import('./index.js')
