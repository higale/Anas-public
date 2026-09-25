const { mkdirSync, readdirSync, statSync, writeFileSync } = require('node:fs')
const { join, relative, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('verify-reproducible-build must be run through npm.')
const root = resolve(process.cwd())
const output = join(root, 'out')

function runBuild() {
  const result = spawnSync(process.execPath, [npmCli, 'run', 'build'], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Clean build failed with exit ${result.status}.`)
}

function manifest(directory) {
  const entries = []
  function visit(current) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) entries.push({
        path: relative(directory, path).replaceAll('\\', '/'),
        bytes: statSync(path).size
      })
      else throw new Error(`Unexpected build output entry: ${path}`)
    }
  }
  visit(directory)
  return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

runBuild()
const first = manifest(output)
mkdirSync(join(output, 'stale'), { recursive: true })
writeFileSync(join(output, 'historical-screenshot.png'), 'stale output')
writeFileSync(join(output, 'stale', 'unexpected.txt'), 'stale output')
runBuild()
const second = manifest(output)

if (JSON.stringify(first) !== JSON.stringify(second)) {
  throw new Error(`Two clean builds produced different manifests.\nFirst: ${JSON.stringify(first)}\nSecond: ${JSON.stringify(second)}`)
}
if (second.some((entry) => entry.path.includes('historical-screenshot') || entry.path.startsWith('stale/'))) {
  throw new Error('A clean build retained injected historical output.')
}

const bytes = second.reduce((total, entry) => total + entry.bytes, 0)
console.log(`Clean build manifest verified: ${second.length} files, ${bytes} bytes.`)
