const { readdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

function listJavaScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return listJavaScriptFiles(path)
    return entry.isFile() && entry.name.endsWith('.js') ? [path] : []
  })
}

const mainOutput = resolve('out/main')
const mainBundle = listJavaScriptFiles(mainOutput)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

if (!/\brequire\((['"])better-sqlite3\1\)/.test(mainBundle)) {
  throw new Error('better-sqlite3 must remain external in the Electron main bundle.')
}
if (!/\brequire\((['"])node-pty\1\)/.test(mainBundle)) {
  throw new Error('node-pty must remain external in the Electron main bundle.')
}

if (mainBundle.includes('Could not dynamically require')) {
  throw new Error('The Electron main bundle contains Rollup dynamic-require fallback code.')
}

console.log('Electron main bundle dependency boundaries verified.')
