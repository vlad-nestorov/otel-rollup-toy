// Starts OpenTelemetry. Imported first by index.js, so it runs before any other
// module of the action is evaluated.
import { start } from 'otel-sdk-init'

start({ serviceName: 'toy-action' })
