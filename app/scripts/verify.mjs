// Builds the toy action with and without OpenTelemetry, runs each build from a folder
// with no node_modules (like an action checkout on a runner) against a fake backend,
// and checks what was exported and propagated.
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSpans, createChecker } from './checks.mjs'
import { startFakeBackend } from './fake-backend.mjs'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const tempDirs = []
const { check, failures } = createChecker()

async function build(config, outDir) {
  await rm(path.join(appDir, outDir), { recursive: true, force: true })
  const result = spawnSync('npx', ['--no-install', 'rollup', '-c', config], {
    cwd: appDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) throw new Error(`rollup -c ${config} failed`)
  return path.join(appDir, outDir)
}

async function isolate(distDir) {
  const root = await mkdtemp(path.join(tmpdir(), 'otel-toy-'))
  tempDirs.push(root)
  await cp(distDir, path.join(root, 'dist'), { recursive: true })
  // Like an action repo's package.json: dist/ is ESM.
  await writeFile(path.join(root, 'package.json'), '{ "type": "module" }\n')
  return root
}

async function runAction(root, env = {}) {
  const backend = await startFakeBackend()
  const child = spawn(process.execPath, [path.join(root, 'dist', 'index.js')], {
    cwd: root,
    // A clean environment: no NODE_OPTIONS, no inherited OTEL_* settings.
    env: {
      PATH: process.env.PATH,
      'INPUT_TARGET-URL': backend.url,
      OTEL_EXPORTER_OTLP_ENDPOINT: backend.url,
      OTEL_ROLLUP_DEBUG: '1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (output += d))
  const code = await new Promise((resolve) => child.on('close', resolve))
  await backend.close()
  return { code, output, spans: backend.spans, requests: backend.requests, exports: backend.exports }
}

async function checkInstrumentedRun(title, root, env) {
  console.log(`\n${title}`)
  const run = await runAction(root, env)
  const started = /\[otel\] hooks=\w+ patched=(\S+)/.exec(run.output)?.[1]

  console.log('      action output:')
  for (const line of run.output.trim().split('\n').slice(-25)) console.log(`        | ${line}`)
  check('action exited 0', run.code === 0)
  check(
    'SDK started and patched node:http and node:https',
    started?.split(',').sort().join(',') === 'http,https',
    started ? `patched=${started}` : 'no [otel] line',
  )
  checkSpans(run, check)
}

try {
  console.log('Building with otel-sdk-init...')
  const dist = await build('rollup.config.js', 'dist')

  console.log('\nBuild output')
  const files = (await readdir(dist, { recursive: true })).sort()
  console.log(`      ${files.join(', ')}`)
  check('a single file, dist/index.js', files.length === 1 && files[0] === 'index.js')
  const bundle = await readFile(path.join(dist, 'index.js'), 'utf8')
  const startCall = bundle.indexOf("serviceName: 'toy-action'")
  check('start() comes before the action code in the bundle', startCall !== -1 && startCall < bundle.indexOf('via-http'))

  const root = await isolate(dist)
  await checkInstrumentedRun(`Run: Node ${process.versions.node}, from ${root}`, root)

  console.log('\nControl: same app built without OpenTelemetry')
  const controlRoot = await isolate(await build('rollup.config.control.js', 'dist-control'))
  const control = await runAction(controlRoot)
  check('action exited 0', control.code === 0, control.code === 0 ? '' : control.output.trim())
  check('no spans exported', control.spans.length === 0, `${control.spans.length} received`)
  check('no traceparent sent', control.requests.every((r) => !r.traceparent))
} catch (err) {
  check('verify script completed', false, err.message)
} finally {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
}

console.log(failures() === 0 ? '\nAll checks passed.' : `\n${failures()} check(s) failed.`)
process.exitCode = failures() === 0 ? 0 : 1
