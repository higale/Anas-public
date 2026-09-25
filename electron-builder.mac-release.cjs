const { execFileSync, spawnSync } = require('node:child_process')
const { readdirSync } = require('node:fs')
const { join } = require('node:path')

if (process.platform !== 'darwin') throw new Error('macOS release packaging must run on macOS.')

if (!['arm64', 'x64'].includes(process.arch)) {
  throw new Error(`Unsupported macOS release architecture: ${process.arch}`)
}

module.exports = {
  extends: './electron-builder.yml',
  directories: { output: 'release-macos' },
  mac: {
    identity: '-',
    hardenedRuntime: false,
    timestamp: 'none',
    notarize: false,
    target: [{ target: 'dmg', arch: [process.arch] }],
    artifactName: '${productName}-${version}-macos-${arch}.${ext}'
  },
  dmg: { sign: false },
  // This hook also runs if signing was skipped. afterSign alone cannot enforce a release gate.
  afterAllArtifactBuild: async ({ outDir }) => {
    const applications = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^mac(?:-|$)/.test(entry.name))
      .flatMap((entry) => readdirSync(join(outDir, entry.name), { withFileTypes: true })
        .filter((child) => child.isDirectory() && child.name.endsWith('.app'))
        .map((child) => join(outDir, entry.name, child.name)))
    if (!applications.length) throw new Error('No macOS application was produced for release verification.')
    for (const application of applications) {
      execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { stdio: 'inherit', timeout: 60_000 })
      // codesign writes signature metadata to stderr.
      const signature = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', application], { encoding: 'utf8', timeout: 60_000 })
      if (signature.error) throw signature.error
      if (signature.status !== 0 || !/^Signature=adhoc\r?$/m.test(signature.stderr)) {
        throw new Error('Release requires a valid ad-hoc signature.')
      }
    }
    return []
  }
}
