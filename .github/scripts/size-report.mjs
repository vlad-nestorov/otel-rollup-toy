// Temporary: builds <dir>/rollup.config.js in memory and reports output file sizes and
// the rendered size of each package in the bundle.
// Usage: node size-report.mjs <dir> [config file, default rollup.config.js]
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = path.resolve(process.argv[2])
const configFile = process.argv[3] ?? 'rollup.config.js'
const root = path.dirname(dir)
process.chdir(dir) // rollup-plugin-otel resolves the SDK from the working directory

const { rollup } = await import(pathToFileURL(createRequire(path.join(dir, 'package.json')).resolve('rollup')))
const config = (await import(pathToFileURL(path.join(dir, configFile)))).default
const bundle = await rollup({ ...config, onwarn() {} })
const { output } = await bundle.generate(config.output)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
let total = 0
const byPackage = {}
const files = []
for (const file of output) {
  if (file.type !== 'chunk') continue
  const bytes = Buffer.byteLength(file.code)
  total += bytes
  files.push(`${file.fileName} ${kb(bytes)}`)
  for (const [id, m] of Object.entries(file.modules)) {
    const rel = path.relative(root, id)
    const pkg = id.startsWith('\0')
      ? '(virtual / commonjs helpers)'
      : (/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(rel)?.[1] ?? `${rel.split(path.sep)[0]}/ (workspace)`)
    byPackage[pkg] = (byPackage[pkg] ?? 0) + m.renderedLength
  }
}
console.log(`## ${process.env.LABEL ?? dir}: ${kb(total)} JavaScript in ${files.length} file(s)`)
console.log(`files: ${files.join(', ')}`)
const top = Object.entries(byPackage).sort((a, b) => b[1] - a[1])
console.log(`packages (rendered): ${top.slice(0, 12).map(([p, n]) => `${p} ${kb(n)}`).join(', ')}`)
if (top.length > 12) console.log(`  ...and ${top.length - 12} more, ${kb(top.slice(12).reduce((s, [, n]) => s + n, 0))} together`)
