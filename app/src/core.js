// Minimal stand-in for @actions/core, with the same input naming rules.

export function getInput(name, { required = false } = {}) {
  const value = process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? ''
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`)
  return value.trim()
}

export function info(message) {
  console.log(message)
}

export function setFailed(message) {
  process.exitCode = 1
  console.log(`::error::${message}`)
}
