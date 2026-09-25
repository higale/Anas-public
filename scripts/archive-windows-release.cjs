const { createReadStream, createWriteStream, existsSync, lstatSync, openSync, readdirSync, renameSync, rmSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pipeline } = require('node:stream/promises')
const { ZipFile } = require('yazl')

async function archiveWindowsRelease(directory, destination) {
  const entries = []
  function visit(current, prefix) {
    const status = lstatSync(current)
    if (status.isDirectory()) {
      entries.push({ directory: true, name: `${prefix}/`, mode: status.mode })
      for (const name of readdirSync(current).sort()) visit(join(current, name), `${prefix}/${name}`)
    } else if (status.isFile()) {
      entries.push({ path: current, name: prefix, mode: status.mode, size: status.size, mtime: status.mtime })
    } else {
      throw new Error(`Unsupported Windows package entry: ${current}`)
    }
  }
  if (!lstatSync(join(directory, 'Anas.exe')).isFile()) throw new Error('Windows package is missing Anas.exe.')
  visit(directory, 'Anas')
  if (existsSync(destination)) throw new Error(`Release archive already exists: ${destination}`)
  const partial = `${destination}.partial`
  if (existsSync(partial)) throw new Error(`Incomplete archive already exists: ${partial}`)
  const zip = new ZipFile()
  // Open the destination before scheduling any input reads.
  const output = createWriteStream(partial, { fd: openSync(partial, 'wx') })
  const readers = new Set()
  const readerClosures = []
  zip.on('error', (error) => zip.outputStream.destroy(error))
  const completed = pipeline(zip.outputStream, output)
  try {
    for (const entry of entries) {
      if (entry.directory) zip.addEmptyDirectory(entry.name, { mode: entry.mode })
      else zip.addReadStreamLazy(entry.name, { mode: entry.mode, size: entry.size, mtime: entry.mtime }, (callback) => {
        const reader = createReadStream(entry.path)
        readers.add(reader)
        readerClosures.push(new Promise((resolve) => reader.once('close', () => { readers.delete(reader); resolve() })))
        reader.on('error', (error) => zip.emit('error', error))
        callback(null, reader)
      })
    }
    zip.end()
    await completed
    await Promise.all(readerClosures)
    renameSync(partial, destination)
  } catch (error) {
    zip.emit('error', error)
    for (const reader of readers) reader.destroy()
    await completed.catch(() => undefined)
    await Promise.all(readerClosures)
    rmSync(partial, { force: true })
    throw error
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows releases must be built on Windows x64.')
  const root = resolve(__dirname, '..')
  const { version } = require('../package.json')
  const destination = join(root, 'release-build', `Anas-${version}-windows-x64.zip`)
  await archiveWindowsRelease(join(root, 'release-build', 'win-unpacked'), destination)
  console.log(`Windows folder archive created: ${destination}`)
}

module.exports = { archiveWindowsRelease }
if (require.main === module) main().catch((error) => { console.error(error); process.exitCode = 1 })
