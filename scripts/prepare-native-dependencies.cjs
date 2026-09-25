const { spawnSync } = require('node:child_process')
const { createRequire } = require('node:module')
const { join, resolve } = require('node:path')

function canUsePtyPrebuild({ appDir, platform, arch, electronVersion }) {
  // Only skip rebuilding a target that this Electron executable can verify.
  // Other targets keep the framework's normal native dependency preparation.
  if (platform !== 'win32' || platform !== process.platform || arch !== process.arch) return false
  const localRequire = createRequire(join(appDir, 'package.json'))
  if (localRequire('electron/package.json').version !== electronVersion) return false
  const result = spawnSync(localRequire('electron'), [join(__dirname, 'verify-pty-prebuild.cjs'), appDir, arch], {
    cwd: appDir, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 15000
  })
  if (result.error || result.status !== 0) {
    console.warn(`node-pty prebuild verification failed; using normal rebuild: ${result.error?.message || result.stderr.trim() || `exit ${result.status}`}`)
    return false
  }
  console.log(result.stdout.trim())
  return true
}

async function prepareNativeDependencies(context = {}) {
  const appDir = resolve(context.appDir || join(__dirname, '..'))
  const localRequire = createRequire(join(appDir, 'package.json'))
  const electronVersion = context.electronVersion || localRequire('electron/package.json').version
  const platform = context.platform?.nodeName || process.platform
  const arch = context.arch || process.arch
  const usePrebuild = canUsePtyPrebuild({ appDir, platform, arch, electronVersion })
  const { rebuild } = await import('@electron/rebuild')
  const result = rebuild({
    buildPath: appDir, projectRootPath: appDir, electronVersion, platform, arch,
    mode: 'sequential', disablePreGypCopy: true,
    ignoreModules: usePrebuild ? ['node-pty'] : []
  })
  result.lifecycle.on('module-rebuild', (name) => console.log(`Preparing native module: ${name}`))
  await result
}

module.exports = (context) => prepareNativeDependencies(context?.packager ? {
  appDir: context.packager.appDir,
  electronVersion: context.packager.config.electronVersion,
  platform: { nodeName: context.electronPlatformName },
  arch: require('electron-builder').Arch[context.arch]
} : context)
module.exports.canUsePtyPrebuild = canUsePtyPrebuild
if (require.main === module) {
  prepareNativeDependencies().catch((error) => { console.error(error); process.exitCode = 1 })
}
