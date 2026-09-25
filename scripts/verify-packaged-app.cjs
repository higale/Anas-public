const { listPackage, extractFile, statFile } = require('@electron/asar')
const { createHash } = require('node:crypto')
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { spawnSync } = require('node:child_process')

const requiredEntries = [
  '/LICENSE',
  '/THIRD_PARTY_NOTICES.md',
  '/out/main/index.js',
  '/out/main/packagedSmoke.js',
  '/out/preload/index.js',
  '/out/renderer/index.html',
  '/licenses/monaco-editor/LICENSE',
  '/licenses/monaco-editor/ThirdPartyNotices.txt',
  '/licenses/dompurify/LICENSE',
  '/licenses/dompurify/LICENSE-MPL',
  '/licenses/marked/LICENSE.md',
  '/node_modules/@langchain/langgraph/dist/index.cjs',
  '/node_modules/@langchain/langgraph-checkpoint/dist/index.cjs',
  '/node_modules/image-dimensions/index.js',
  '/node_modules/mediainfo.js/dist/cjs/index.cjs',
  '/node_modules/mediainfo.js/dist/MediaInfoModule.wasm',
  '/node_modules/mediainfo.js/LICENSE.txt',
  '/node_modules/exifr/dist/full.umd.js',
  '/node_modules/exifr/LICENSE',
  '/node_modules/koffi/index.cjs',
  '/node_modules/node-pty/lib/index.js',
  '/node_modules/node-pty/LICENSE',
  '/node_modules/shell-quote/index.js',
  '/node_modules/@vscode/ripgrep/lib/index.js'
]
const packageBudget = {
  asarBytes: 225 * 1024 * 1024,
  unpackedBytes: 700 * 1024 * 1024,
  asarEntries: 25_000
}

function directoryBytes(directory, root = realpathSync(directory)) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) total += directoryBytes(path, root)
    else if (entry.isFile()) total += statSync(path).size
    else if (entry.isSymbolicLink()) {
      // Framework bundles contain links to their versioned files/directories.
      // Count the link itself; its target is counted by the ordinary traversal.
      const target = realpathSync(path)
      const location = relative(root, target)
      if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
        throw new Error(`Packaged output link escapes the application: ${path}`)
      }
      const status = statSync(target)
      if (!status.isFile() && !status.isDirectory()) throw new Error(`Unexpected packaged link target: ${path}`)
      total += lstatSync(path).size
    }
    else throw new Error(`Unexpected packaged output entry: ${path}`)
  }
  return total
}

function findPackagedAsar(targetDirectory, depth = 0) {
  const root = resolve(targetDirectory)
  const direct = join(root, 'resources', 'app.asar')
  const mac = join(root, 'Contents', 'Resources', 'app.asar')
  if (existsSync(direct)) return direct
  if (existsSync(mac)) return mac
  if (depth >= 3) return undefined
  const matches = readdirSync(root, { withFileTypes: true }).flatMap((entry) => (
    entry.isDirectory() ? [findPackagedAsar(join(root, entry.name), depth + 1)].filter(Boolean) : []
  ))
  if (matches.length > 1) throw new Error(`Multiple packaged applications found under ${root}.`)
  return matches[0]
}

function packagePaths(unpackedDirectory) {
  const asar = findPackagedAsar(unpackedDirectory)
  if (!asar) throw new Error(`Packaged application ASAR is missing under ${resolve(unpackedDirectory)}.`)
  const resources = dirname(asar)
  const macContents = basename(resources) === 'Resources' && basename(dirname(resources)) === 'Contents'
    ? dirname(resources)
    : undefined
  const root = macContents ? dirname(macContents) : dirname(resources)
  const executableCandidates = macContents
    ? readdirSync(join(macContents, 'MacOS')).map((entry) => join(macContents, 'MacOS', entry))
    : process.platform === 'win32'
      ? [join(root, 'Anas.exe')]
      : [join(root, 'anas'), join(root, 'Anas')]
  const executable = executableCandidates.find((candidate) => existsSync(candidate))
  if (!executable) throw new Error(`Packaged application executable is missing under ${root}.`)
  return {
    root,
    executable,
    resources,
    asar,
    native: join(
      resources,
      'app.asar.unpacked',
      'node_modules',
      'better-sqlite3',
      'build',
      'Release',
      'better_sqlite3.node'
    )
  }
}

function packageManifest(unpackedDirectory) {
  const paths = packagePaths(unpackedDirectory)
  for (const path of [paths.executable, paths.asar, paths.native]) {
    if (!existsSync(path)) throw new Error(`Packaged application file is missing: ${path}`)
  }
  const rawEntries = listPackage(paths.asar)
  const rawEntryByNormalized = new Map(rawEntries.map((entry) => [entry.replaceAll('\\', '/'), entry]))
  const entries = [...rawEntryByNormalized.keys()].sort()
  const set = new Set(entries)
  if (set.has('/node_modules/monaco-editor')) {
    throw new Error('Monaco must be bundled into the renderer, not shipped again as a production dependency.')
  }
  for (const entry of requiredEntries) {
    if (!set.has(entry)) throw new Error(`Packaged application entry is missing: ${entry}`)
  }
  const ptyNativeEntries = entries.filter((entry) => /^\/node_modules\/node-pty\/(?:build\/Release|prebuilds\/[^/]+)\/[^/]+\.node$/.test(entry))
  if (!ptyNativeEntries.length) throw new Error('Packaged node-pty native bindings are missing.')
  const ptyExecutables = entries.filter((entry) => /^\/node_modules\/node-pty\/.*(?:spawn-helper|\.exe|\.dll)$/.test(entry))
  for (const entry of [...ptyNativeEntries, ...ptyExecutables]) {
    if (statFile(paths.asar, rawEntryByNormalized.get(entry).slice(1)).unpacked !== true
      || !existsSync(join(paths.resources, 'app.asar.unpacked', ...entry.slice(1).split('/')))) {
      throw new Error(`Packaged PTY binary must exist outside ASAR: ${entry}`)
    }
  }
  for (const dependency of ['p-queue', 'p-retry']) {
    if (!entries.some((entry) => (
      entry.includes('/@langchain/langgraph-sdk/dist/node_modules/.pnpm/')
      && entry.includes(`/node_modules/${dependency}/`)
      && entry.endsWith('.cjs')
    ))) throw new Error(`Packaged LangGraph SDK dependency is missing: ${dependency}`)
  }
  const koffiNativeEntries = entries.filter((entry) => (
    /^\/node_modules\/@koromix\/koffi-[^/]+\/[^/]+\/koffi\.node$/.test(entry)
  ))
  if (koffiNativeEntries.length !== 1) {
    throw new Error(`Packaged Koffi native binding count is ${koffiNativeEntries.length}; expected exactly one.`)
  }
  const koffiNativeEntry = koffiNativeEntries[0]
  const koffiNativeRawEntry = rawEntryByNormalized.get(koffiNativeEntry)
  if (!koffiNativeRawEntry) throw new Error(`Packaged Koffi entry is missing: ${koffiNativeEntry}`)
  if (statFile(paths.asar, koffiNativeRawEntry.slice(1)).unpacked !== true) {
    throw new Error(`Packaged Koffi native binding is not unpacked: ${koffiNativeEntry}`)
  }
  const nativeKoffi = join(
    paths.resources,
    'app.asar.unpacked',
    ...koffiNativeEntry.slice(1).split('/')
  )
  if (!existsSync(nativeKoffi)) {
    throw new Error(`Packaged Koffi native binding is missing: ${nativeKoffi}`)
  }
  const packageJson = JSON.parse(extractFile(paths.asar, 'package.json').toString('utf8'))
  const searchBinaries = entries.filter((entry) => /^\/node_modules\/@vscode\/ripgrep-[^/]+\/bin\/rg(?:\.exe)?$/.test(entry))
  if (searchBinaries.length !== 1) throw new Error(`Expected one packaged ripgrep binary, found ${searchBinaries.length}.`)
  const searchEntry = searchBinaries[0]
  if (!statFile(paths.asar, rawEntryByNormalized.get(searchEntry).slice(1)).unpacked
    || !existsSync(join(paths.resources, 'app.asar.unpacked', ...searchEntry.slice(1).split('/')))) {
    throw new Error(`Packaged ripgrep binary must exist outside ASAR: ${searchEntry}`)
  }
  const searchPackage = searchEntry.slice(0, searchEntry.indexOf('/bin/'))
  if (!set.has(`${searchPackage}/LICENSE`)) throw new Error('Packaged ripgrep license is missing.')
  const asarFiles = entries.flatMap((entry) => {
    const rawEntry = rawEntryByNormalized.get(entry)
    if (!rawEntry) throw new Error(`Packaged entry is missing: ${entry}`)
    const status = statFile(paths.asar, rawEntry.slice(1))
    return typeof status.size === 'number' ? [{ path: entry, bytes: status.size }] : []
  })
  asarFiles.sort((left, right) => right.bytes - left.bytes || (left.path < right.path ? -1 : 1))
  const report = {
    version: packageJson.version,
    asarEntries: entries.length,
    asarManifestSha256: createHash('sha256').update(entries.join('\n')).digest('hex'),
    asarBytes: statSync(paths.asar).size,
    unpackedBytes: directoryBytes(paths.root),
    executableBytes: statSync(paths.executable).size,
    nativeSqliteBytes: statSync(paths.native).size,
    nativeKoffiBytes: statSync(nativeKoffi).size,
    largestAsarFiles: asarFiles.slice(0, 50)
  }
  const reportPath = join(dirname(paths.root), 'package-report.json')
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  for (const [field, budget] of Object.entries(packageBudget)) {
    if (report[field] > budget) {
      throw new Error(`Packaged application exceeds ${field} budget: ${report[field]} > ${budget}. Package report: ${reportPath}`)
    }
  }
  return { paths, entries, report, reportPath, version: packageJson.version }
}

function smoke(manifest) {
  const home = mkdtempSync(join(tmpdir(), 'anas-packaged-home-'))
  try {
    mkdirSync(join(home, 'Documents'))
    const result = spawnSync(manifest.paths.executable, [
      '--anas-packaged-smoke',
      `--user-data-dir=${join(home, 'electron')}`
    ], {
      cwd: manifest.paths.resources,
      env: {
        ...process.env,
        ANAS_PACKAGED_SMOKE: '1',
        ELECTRON_RENDERER_URL: 'https://renderer-environment-must-be-ignored.invalid/',
        HOME: home,
        USERPROFILE: home
      },
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true
    })
    if (result.error) throw result.error
    if (result.status !== 0 || !result.stdout.includes('ANAS_PACKAGED_SMOKE_OK')) {
      throw new Error([
        `Packaged Agent smoke failed for ${basename(manifest.paths.root)} (exit ${result.status}).`,
        result.stdout,
        result.stderr
      ].filter(Boolean).join('\n'))
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function main() {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'verify' && args.length === 1) {
    const manifest = packageManifest(args[0])
    smoke(manifest)
    console.log(`Packaged application verified: ${manifest.paths.root} (${manifest.entries.length} ASAR entries).`)
    console.log(`Package report: ${manifest.reportPath}`)
  } else if (command === 'compare' && args.length === 2) {
    const left = packageManifest(args[0])
    const right = packageManifest(args[1])
    if (left.version !== right.version) throw new Error('Packaged application versions differ.')
    if (JSON.stringify(left.entries) !== JSON.stringify(right.entries)) {
      const leftOnly = left.entries.filter((entry) => !right.entries.includes(entry)).slice(0, 20)
      const rightOnly = right.entries.filter((entry) => !left.entries.includes(entry)).slice(0, 20)
      throw new Error(`Packaged ASAR manifests differ.\nNormal only: ${leftOnly.join(', ')}\nPortable only: ${rightOnly.join(', ')}`)
    }
    console.log(`Packaged application manifests match (${left.entries.length} entries).`)
  } else {
    throw new Error('Usage: verify-packaged-app.cjs verify <package-output> | compare <normal> <portable>')
  }
}

module.exports = { directoryBytes }
if (require.main === module) main()
