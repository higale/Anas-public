const assert = require('node:assert/strict')
const { existsSync } = require('node:fs')
const { createRequire } = require('node:module')
const { join, resolve, sep } = require('node:path')

assert.ok(process.versions.electron, 'Verification must run in Electron.')
assert.equal(process.platform, 'win32')
assert.equal(process.arch, process.argv[3])
const localRequire = createRequire(join(resolve(process.argv[2]), 'package.json'))
const moduleRoot = join(localRequire.resolve('node-pty/package.json'), '..')
const prebuild = resolve(moduleRoot, 'prebuilds', `win32-${process.arch}`)
for (const file of ['conpty.node', 'conpty_console_list.node', 'conpty/conpty.dll', 'conpty/OpenConsole.exe']) {
  assert.ok(existsSync(join(prebuild, file)), `Missing node-pty prebuild file: ${file}`)
}
localRequire(join(prebuild, 'conpty_console_list.node'))
const terminal = localRequire('node-pty').spawn(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/c', 'echo ANAS_NATIVE_PTY_READY'], {
  cols: 80, rows: 24, env: process.env
})
let output = ''
const deadline = setTimeout(() => {
  terminal.kill()
  console.error('node-pty prebuild command timed out.')
  process.exit(1)
}, 10000)
terminal.onData((text) => { output += text })
terminal.onExit(({ exitCode }) => {
  clearTimeout(deadline)
  try {
    assert.equal(exitCode, 0)
    assert.ok(output.includes('ANAS_NATIVE_PTY_READY'), 'No command output from node-pty.')
    const bindings = Object.keys(require.cache).filter((file) => file.endsWith('.node') && file.startsWith(resolve(moduleRoot) + sep))
    assert.equal(bindings.length, 2)
    assert.ok(bindings.every((file) => file.startsWith(prebuild + sep)), 'node-pty selected a locally compiled binding instead of its prebuild.')
    console.log(`Verified node-pty prebuild: ${process.platform}-${process.arch}, Electron ${process.versions.electron}`)
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
