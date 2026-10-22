// Temporary diagnostics: bundles the action three ways and reports what each leaves behind.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { rollup } from 'rollup'
import commonjs from '@rollup/plugin-commonjs'
import { nodeResolve } from '@rollup/plugin-node-resolve'

const appDir = path.resolve(import.meta.dirname, '..')
const httpCjs = createRequire(path.join(appDir, 'package.json')).resolve('@opentelemetry/instrumentation-http')

const variants = {
  'esm (exportConditions: [node])': { conditions: ['node'] },
  'all cjs (exportConditions: [node, require])': { conditions: ['node', 'require'] },
  'only instrumentation-http as cjs': { conditions: ['node'], alias: { '@opentelemetry/instrumentation-http': httpCjs } },
}

for (const [name, { conditions, alias = {} }] of Object.entries(variants)) {
  const bundle = await rollup({
    input: path.join(appDir, 'src/index.js'),
    onwarn: () => {},
    plugins: [
      { name: 'alias', resolveId: (source) => alias[source] ?? null },
      nodeResolve({ exportConditions: conditions, preferBuiltins: true, rootDir: appDir }),
      commonjs(),
    ],
  })
  const { output } = await bundle.generate({ format: 'es', inlineDynamicImports: true })
  const [chunk] = output
  const byPackage = {}
  for (const [id, m] of Object.entries(chunk.modules)) {
    const pkg = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(id)?.[1] ?? (id.includes('/sdk/') ? 'otel-sdk-init' : id.startsWith('\0') ? 'commonjs helpers' : 'app')
    byPackage[pkg] = (byPackage[pkg] ?? 0) + m.renderedLength
  }
  const leftover = [...chunk.code.matchAll(/__require\w*\("([^"]+)"\)/g)].map((m) => m[1])
  console.log(`\n### ${name}: ${(chunk.code.length / 1024).toFixed(0)} KB`)
  console.log(`  runtime requires left: ${leftover.length ? leftover.join(', ') : 'none'}`)
  console.log('  largest packages: ' + Object.entries(byPackage).sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([p, n]) => `${p} ${(n / 1024).toFixed(0)}KB`).join(', '))

  // Run it where there are no node_modules above it, like a deployed action...
  const isolated = mkdtempSync(path.join(tmpdir(), 'diag-'))
  writeFileSync(path.join(isolated, 'package.json'), '{ "type": "module" }')
  writeFileSync(path.join(isolated, 'index.js'), chunk.code)
  // ...and next to the repo's node_modules, like a local test run.
  const inRepo = path.join(appDir, 'diag-out')
  mkdirSync(inRepo, { recursive: true })
  writeFileSync(path.join(inRepo, 'index.js'), chunk.code)
  for (const [where, dir] of [['isolated', isolated], ['inside the repo', inRepo]]) {
    const r = spawnSync(process.execPath, ['index.js'], {
      cwd: dir, encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, 'INPUT_TARGET-URL': 'http://127.0.0.1:9' },
    })
    const line = `${r.stdout}${r.stderr}`.split('\n').find((l) => /Error|error|->/.test(l)) ?? '(no output)'
    console.log(`  run ${where}: exit ${r.status}: ${line.trim().slice(0, 110)}`)
  }
}
