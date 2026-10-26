// GitHub Actions support for otel-sdk-init: service.name from an action input, and what
// the action logs through @actions/core exported as OpenTelemetry log records.
//
// @actions/core writes every log call to process.stdout. info() writes the message as a
// line; debug(), notice(), warning() and error() (which setFailed() calls) write workflow
// commands such as `::warning file=app.js,line=3::message`. Watching process.stdout
// therefore covers every call, from whichever copy of @actions/core made it and however
// it was bundled, including the calls @actions/core makes internally. It also covers
// console.log(), which the runner shows the same way as info().
//
// No dependencies, so it bundles anywhere: the severity numbers below are the fixed
// values of SeverityNumber in @opentelemetry/api.

import { StringDecoder } from 'node:string_decoder'
import { format } from 'node:util'

/** An action input, read the way @actions/core's getInput() reads it: '' when unset. */
export function actionInput(name) {
  return (process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim()
}

/**
 * service.name: the action input when it's set, then OTEL_SERVICE_NAME, then the
 * built-in default. Declare the input in action.yml without a default, or the runner
 * always sets it and OTEL_SERVICE_NAME never applies.
 */
export function serviceNameFrom({ serviceName, serviceNameInput }) {
  return (serviceNameInput && actionInput(serviceNameInput)) || process.env.OTEL_SERVICE_NAME || serviceName
}

/** A DiagLogger that writes to stderr, so OTel's own diagnostics never look like action logs. */
export const stderrDiagLogger = Object.fromEntries(
  ['error', 'warn', 'info', 'debug', 'verbose'].map((level) => [
    level,
    (message, ...args) => process.stderr.write(`[otel] ${level}: ${format(message, ...args)}\n`),
  ]),
)

const INFO = 9
// Workflow commands that are log lines, and their severity.
const LOG_COMMANDS = { debug: 5, notice: 10, warning: 13, error: 17 }

// ::name key=value,key=value::message. @actions/core escapes ':' and ',' in property
// values, so the first '::' after the name ends the properties.
const COMMAND = /^::([^\s:]+)(?: ([^:]*))?::(.*)$/
const DATA_ESCAPES = { '%25': '%', '%0D': '\r', '%0A': '\n' }
const PROPERTY_ESCAPES = { ...DATA_ESCAPES, '%3A': ':', '%2C': ',' }
const unescape = (text, table) => text.replace(/%(?:25|0D|0A|3A|2C)/gi, (code) => table[code.toUpperCase()] ?? code)

/**
 * Emits each line the action writes to process.stdout as a log record on `logger`:
 * plain lines at INFO, ::debug::, ::notice::, ::warning:: and ::error:: at their own
 * severity with the message as the body and annotation properties as attributes. Other
 * workflow commands (groups, outputs, state) aren't logs and are skipped. Values
 * registered with core.setSecret() (::add-mask::) are replaced by *** in what is
 * exported, as the runner does in its own log.
 *
 * @param {import('@opentelemetry/api').Logger} logger
 * @returns {{ stop(): void }} stop() emits any unterminated last line and restores
 *   process.stdout.write.
 */
export function captureActionsLogs(logger) {
  const stdout = process.stdout
  const originalWrite = stdout.write
  const decoder = new StringDecoder('utf8')
  const masks = []
  let pending = ''
  let stopToken = null // set by ::stop-commands::<token>, cleared by the line ::<token>::
  let busy = false

  const mask = (text) => masks.reduce((masked, secret) => masked.split(secret).join('***'), text)

  function emit(severityNumber, severityText, message, attributes) {
    if (message.trim() === '') return
    logger.emit({ severityNumber, severityText, body: mask(message), attributes })
  }

  function onLine(line) {
    if (stopToken !== null) {
      if (line === `::${stopToken}::`) stopToken = null
      else emit(INFO, 'info', line)
      return
    }
    const command = COMMAND.exec(line)
    if (!command) return emit(INFO, 'info', line)

    const [, name, properties = '', data] = command
    const message = unescape(data, DATA_ESCAPES)
    if (name === 'add-mask') {
      if (message && !masks.includes(message)) {
        masks.push(message)
        // Longest first, so a secret that contains another is masked whole.
        masks.sort((a, b) => b.length - a.length)
      }
    } else if (name === 'stop-commands') {
      stopToken = message
    } else if (name in LOG_COMMANDS) {
      const attributes = {}
      for (const property of properties.split(',')) {
        const separator = property.indexOf('=')
        if (separator > 0) {
          attributes[`actions.annotation.${property.slice(0, separator)}`] = mask(
            unescape(property.slice(separator + 1), PROPERTY_ESCAPES),
          )
        }
      }
      emit(LOG_COMMANDS[name], name, message, attributes)
    }
  }

  function onText(text) {
    pending += text
    let newline
    while ((newline = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      onLine(line.endsWith('\r') ? line.slice(0, -1) : line)
    }
  }

  function write(chunk, encoding) {
    if (!busy) {
      busy = true
      try {
        if (typeof chunk !== 'string') onText(decoder.write(chunk))
        else if (typeof encoding === 'string' && !/^utf-?8$/i.test(encoding)) onText(Buffer.from(chunk, encoding).toString())
        else onText(chunk)
      } catch {
        // Telemetry must never break the action's own output.
      } finally {
        busy = false
      }
    }
    return originalWrite.apply(this, arguments)
  }
  stdout.write = write

  return {
    stop() {
      if (stdout.write === write) stdout.write = originalWrite
      const rest = pending + decoder.end()
      pending = ''
      if (rest) onLine(rest)
    },
  }
}
