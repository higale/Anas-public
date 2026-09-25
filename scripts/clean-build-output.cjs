const { lstatSync, rmSync } = require('node:fs')
const { basename, dirname, resolve } = require('node:path')

const targetNames = {
  build: ['out'],
  pack: ['release-build'],
  'mac-release': ['release-macos'],
  portable: ['release-portable']
}

function removeOutput(root, name) {
  const target = resolve(root, name)
  if (dirname(target) !== root || basename(target) !== name) {
    throw new Error(`Refusing to clean an unexpected build path: ${target}`)
  }
  try {
    const status = lstatSync(target)
    if (status.isSymbolicLink()) {
      throw new Error(`Refusing to clean a linked build path: ${target}`)
    }
  } catch (reason) {
    if (reason?.code === 'ENOENT') return
    throw reason
  }
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
  } catch (reason) {
    if (reason?.code === 'EBUSY' || reason?.code === 'EPERM') {
      throw new Error(
        `Cannot clean ${target} because a process is using it. Close packaged Anas and any release smoke processes, then retry.`,
        { cause: reason }
      )
    }
    throw reason
  }
}

const mode = process.argv[2]
const targets = targetNames[mode]
if (!targets) {
  throw new Error(`Usage: clean-build-output.cjs <${Object.keys(targetNames).join('|')}>`)
}

const root = resolve(process.cwd())
for (const name of targets) removeOutput(root, name)
console.log(`Cleaned ${targets.join(', ')} output.`)
