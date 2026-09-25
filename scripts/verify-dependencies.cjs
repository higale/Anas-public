const { spawnSync } = require('node:child_process')

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('verify-dependencies must be run through npm.')
const result = spawnSync(process.execPath, [npmCli, 'ls', '--all', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true
})
if (result.error) throw result.error

let tree
try {
  tree = JSON.parse(result.stdout)
} catch (reason) {
  throw new Error('npm ls did not return a valid dependency tree.', { cause: reason })
}

const problems = Array.isArray(tree.problems) ? tree.problems : []
if (result.status !== 0 || problems.length > 0) {
  throw new Error([
    `npm ls reported an invalid dependency tree (exit ${result.status}).`,
    ...problems,
    result.stderr
  ].filter(Boolean).join('\n'))
}

console.log('Dependency tree verified: no missing, invalid, or extraneous packages.')
