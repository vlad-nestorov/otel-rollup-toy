// The action's source. Nothing here knows about OpenTelemetry.
import http from 'node:http'
import DataLoader from 'dataloader'
import { getInput, info, setFailed } from './core.js'

// A third-party library that ends up in the bundle, unlike node:http and fetch.
const doubler = new DataLoader(async (keys) => keys.map((key) => key * 2))

async function run() {
  try {
    const target = getInput('target-url', { required: true })
    const viaHttp = await get(`${target}/via-http`)
    const viaFetch = (await fetch(`${target}/via-fetch`)).status
    const doubled = await doubler.load(21)
    info(`http.get -> ${viaHttp}, fetch -> ${viaFetch}, dataloader -> ${doubled}`)
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
