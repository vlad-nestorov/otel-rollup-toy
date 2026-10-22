// Builds the toy action with and without the plugin, runs each build from a folder
// with no node_modules (like an action checkout on a runner) against a fake backend,
// and checks what was exported and propagated.
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSpans, createChecker, runtimeRequiresIn } from './checks.mjs'
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
  const mode = /\[otel\] hooks=(\w+)/.exec(run.output)?.[1]

  console.log('      action output:')
  for (const line of run.output.trim().split('\n').slice(-25)) console.log(`        | ${line}`)
  check('action exited 0', run.code === 0)
  check('bootstrap registered the loader hooks', Boolean(mode), mode ? `hooks=${mode}` : 'no [otel] line')
  checkSpans(run, check)
  return mode
}

try {
  console.log('Building with rollup-plugin-otel...')
  const dist = await build('rollup.config.js', 'dist')

  console.log('\nBuild output')
  const files = (await readdir(dist, { recursive: true })).sort()
  console.log(`      ${files.join(', ')}`)
  const sizes = await Promise.all(files.filter((f) => /\.m?js$/.test(f)).map((f) => stat(path.join(dist, f))))
  console.log(`      JavaScript total: ${(sizes.reduce((sum, s) => sum + s.size, 0) / 1024).toFixed(0)} KB`)
  for (const [file, role] of [
    ['index.js', 'bootstrap entry'],
    ['otel-hook.mjs', 'off-thread loader hook'],
    ['otel-iitm-register.mjs', 'import-in-the-middle registry'],
    ['package.json', 'type: module marker'],
  ]) {
    check(`${file} (${role})`, files.includes(file))
  }
  const entry = await readFile(path.join(dist, 'index.js'), 'utf8')
  check('entry loads the app with a dynamic import()', /\bimport\(/.test(entry))
  check('app code is not in the entry chunk', !entry.includes('via-http'))
  // OTel's ESM builds load forwarded-parse through a createRequire shim, which the plugin
  // rewrites into a static import (see "The createRequire shim" in the README).
  const leftovers = await runtimeRequiresIn(dist)
  check('no non-builtin module left to require() at runtime', leftovers.length === 0, leftovers.join(', '))

  const root = await isolate(dist)
  const autoMode = await checkInstrumentedRun(
    `Run 1: hooks picked automatically (Node ${process.versions.node}), from ${root}`,
    root,
  )
  if (autoMode !== 'async') {
    await checkInstrumentedRun('Run 2: forced off-thread hooks (OTEL_ROLLUP_HOOKS=async)', root, {
      OTEL_ROLLUP_HOOKS: 'async',
    })
  } else {
    console.log(
      `\n  note: in-thread sync hooks need Node >= 22.22.3 or >= 24.11.1; ` +
        `Node ${process.versions.node} used the off-thread hook file, so only that path was exercised`,
    )
  }

  console.log('\nControl: same app built without the plugin')
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
