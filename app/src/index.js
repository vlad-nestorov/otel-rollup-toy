// The action's source. Nothing here knows about OpenTelemetry.
import http from 'node:http'
import { debug, getInput, info, setFailed, setSecret } from '@actions/core'

async function run() {
  try {
    const target = getInput('target-url', { required: true })
    // Logged only to show that a registered secret is masked in the runner's log and
    // in the exported log records alike.
    const token = getInput('api-token')
    if (token) {
      setSecret(token)
      debug(`api-token: ${token}`)
    }
    const viaHttp = await get(`${target}/via-http`)
    const viaFetch = (await fetch(`${target}/via-fetch`)).status
    info(`http.get -> ${viaHttp}, fetch -> ${viaFetch}`)
  } catch (err) {
    setFailed(err.message)
  }
}

function get(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      .on('error', reject)
  })
}

// Not awaited, like most actions' main file.
run()
