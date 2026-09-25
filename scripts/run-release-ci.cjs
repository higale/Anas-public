const { spawnSync } = require('node:child_process')

const npmCli = process.env.npm_execpath
if (!npmCli) throw new Error('run-release-ci must be run through npm.')

function run(args) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed with exit ${result.status}.`)
}

run(['ci', '--no-audit', '--no-fund'])
run(['run', 'verify:dependencies'])
run(['run', 'verify:audit'])
run(['run', 'typecheck'])
run(['run', 'lint'])
run(['run', 'test:coverage'])
run(['run', 'test:dom'])
run(['run', 'test:e2e'])
run(['run', 'verify:release-packages'])
