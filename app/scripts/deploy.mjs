// Lays out the built action the way a runner would check it out from a release:
// action.yml and dist/, plus a production node_modules when the bundle leaves
// dependencies external.
// Usage: node deploy.mjs <out-dir> [dist-dir]
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = path.dirname(appDir)

// Does dist/ import the app's dependencies at runtime instead of bundling them?
export const SHIP_NODE_MODULES = false

export async function deploy(outDir, distDir = path.join(appDir, 'dist'), { shipNodeModules = SHIP_NODE_MODULES } = {}) {
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await cp(distDir, path.join(outDir, 'dist'), { recursive: true })
  await cp(path.join(appDir, 'action.yml'), path.join(outDir, 'action.yml'))

  const appPackage = JSON.parse(await readFile(path.join(appDir, 'package.json'), 'utf8'))
  const dependencies = { ...appPackage.dependencies }

  if (shipNodeModules) {
    // Workspace packages aren't on npm: pack them and install the tarballs.
    const packs = path.join(outDir, '.packs')
    await mkdir(packs)
    for (const [name, range] of Object.entries(dependencies)) {
      if (range !== '*') continue
      const packed = run('npm', ['pack', '--workspace', name, '--pack-destination', packs, '--silent'], repoRoot)
      dependencies[name] = `file:.packs/${packed.trim().split('\n').at(-1)}`
    }
  }

  await writeFile(
    path.join(outDir, 'package.json'),
    `${JSON.stringify({ private: true, type: 'module', dependencies: shipNodeModules ? dependencies : {} }, null, 2)}\n`,
  )
  if (shipNodeModules) {
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], outDir)
  }
  return outDir
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: process.platform === 'win32' })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`)
  }
  return result.stdout
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [outDir, distDir] = process.argv.slice(2)
  if (!outDir) throw new Error('usage: deploy.mjs <out-dir> [dist-dir]')
  await deploy(path.resolve(outDir), distDir && path.resolve(distDir))
  console.log(`deployed the action to ${outDir}`)
}
