const { existsSync } = require('node:fs')

const defaultElectronMirror = 'https://npmmirror.com/mirrors/electron/'
const configuredMirror = [
  process.env.npm_config_electron_mirror,
  process.env.NPM_CONFIG_ELECTRON_MIRROR,
  process.env.ELECTRON_MIRROR
].find((value) => value?.trim())

if (!configuredMirror) process.env.ELECTRON_MIRROR = defaultElectronMirror

const executablePath = require('electron')
if (typeof executablePath !== 'string' || !existsSync(executablePath)) {
  throw new Error('Electron executable was not installed successfully.')
}

process.stdout.write(`Electron ready: ${executablePath}\n`)
