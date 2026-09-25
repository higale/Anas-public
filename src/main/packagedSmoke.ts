import { app } from 'electron'
import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { configureDataRuntime } from './config/dataDir'

function denyNetwork(): never {
  throw new Error('Packaged Agent smoke attempted network access.')
}

export async function runPackagedSmoke(): Promise<void> {
  globalThis.fetch = denyNetwork
  http.request = denyNetwork as typeof http.request
  http.get = denyNetwork as typeof http.get
  https.request = denyNetwork as typeof https.request
  https.get = denyNetwork as typeof https.get
  net.connect = denyNetwork as typeof net.connect
  net.createConnection = denyNetwork as typeof net.createConnection
  tls.connect = denyNetwork as typeof tls.connect

  const { resolveRendererLocation } = await import('./ipcSecurity')
  const rendererLocation = resolveRendererLocation({
    isPackaged: true,
    rendererFile: join(__dirname, '../renderer/index.html'),
    rendererUrl: process.env.ELECTRON_RENDERER_URL
  })
  if (rendererLocation.kind !== 'local') {
    throw new Error('Packaged application accepted an environment-provided renderer URL.')
  }
  if (process.platform === 'win32') {
    const { createWindowsKillOnCloseJob } = await import('./windowsProcessJob')
    const job = createWindowsKillOnCloseJob()
    job.close()
  }

  const root = await mkdtemp(join(tmpdir(), 'anas-packaged-smoke-'))
  try {
    const documents = join(root, 'Documents')
    await mkdir(documents)
    const { readFileContentInfo } = await import('./fileMetadata')
    const imagePath = join(documents, 'metadata.png')
    await writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'))
    const imageFile = await open(imagePath, 'r')
    try {
      const metadata = await readFileContentInfo(imageFile, await imageFile.stat(), imagePath)
      if (metadata.media?.kind !== 'image' || metadata.media.width !== 1 || metadata.media.height !== 1 || metadata.media.hasAlpha !== true) {
        throw new Error(`Packaged local media metadata failed: ${JSON.stringify(metadata)}`)
      }
    } finally { await imageFile.close() }
    app.setPath('documents', documents)
    configureDataRuntime([process.execPath, '--data-dir', root])
    const { bundledSearchEnvironment } = await import('./bundledRipgrep')
    const { createShellCommandAuthorization } = await import('./shellCommandAuthorization')
    const { getCommandShell, prepareShellCommand, runShellCommand, runPreparedProcess } = await import('./shellRuntime')
    await writeFile(join(documents, 'search smoke 中文.txt'), 'packaged-search-marker\n', 'utf8')
    // Exercise the packaged default zsh contract independently of personal aliases.
    const searchEnvironment = await bundledSearchEnvironment({ ...process.env,
      ...(process.platform === 'darwin' ? { ZDOTDIR: root } : {}) })
    const shell = await getCommandShell()
    const authorization = createShellCommandAuthorization({ shell, env: searchEnvironment.env, rgExecutable: searchEnvironment.executable,
      primaryFolder: documents, trustedFolders: [documents], accessMode: () => 'strict_approval' })
    const searchArgs = Object.freeze({ command: "rg -n -g '*.txt' packaged-search-marker .", working_dir: documents })
    const needsApproval = await authorization.requiresApproval(searchArgs)
    if ((process.platform === 'win32' || process.platform === 'darwin' && shell.executable === '/bin/zsh') && needsApproval) {
      throw new Error('Packaged rg read analysis did not auto-approve the fixture.')
    }
    const prepared = await prepareShellCommand({ command: String(searchArgs.command), workingDir: String(searchArgs.working_dir) }, documents)
    if ('ok' in prepared) throw new Error(prepared.error)
    prepared.env = searchEnvironment.env
    prepared.pathPrepend = searchEnvironment.directory
    let searchSucceeded = false
    const search = await runShellCommand(prepared, shell, undefined, {
      onResult: (result) => { searchSucceeded = result.ok }
    })
    if (!searchSucceeded || !search.includes('1:packaged-search-marker')) {
      throw new Error(`Packaged ripgrep Shell search failed: ${search}`)
    }
    let terminalSucceeded = false
    let terminalInputResult: Promise<void> | undefined
    const terminalOutput = await runPreparedProcess({
      command: 'packaged PTY input probe', workingDir: documents, timeoutSec: 15,
      pty: { columns: 100, rows: 30 }, invocation: { executable: process.platform === 'win32' ? shell.executable : process.execPath,
        args: process.platform === 'win32'
          ? ['-NoLogo', '-NoProfile', '-Command', "[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); if([Console]::IsInputRedirected -or [Console]::IsOutputRedirected){exit 2}; Write-Output READY; $line=[Console]::ReadLine(); Write-Output ('PTY_REPLY:'+$line)"]
          : ['-e', `if(!process.stdin.isTTY||!process.stdout.isTTY)process.exit(2);process.stdin.once('data',v=>{console.log('PTY_REPLY:'+String(v).trim());process.exit(0)})`],
        windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } },
      logScope: 'packaged-smoke', successMessage: 'PTY smoke passed.', failureMessage: 'PTY smoke failed.',
      abortBeforeStartError: 'PTY cancelled before start.', abortError: 'PTY cancelled.', timeoutError: 'PTY smoke timed out.'
    }, undefined, { onTerminal: (terminal) => {
      terminalInputResult = Promise.resolve(terminal.apply({ type: 'text', text: '中文 smoke\r' }))
      void terminalInputResult.catch(() => {}) // Observed below after the executor has drained.
    },
      onResult: (result) => { terminalSucceeded = result.ok } })
    await terminalInputResult
    if (!terminalSucceeded || !terminalOutput.includes('PTY_REPLY:中文 smoke')) throw new Error(`Packaged terminal probe failed: ${terminalOutput}`)
    const [{ AgentDatabase }, { createAgentInstance }, appConfig] = await Promise.all([
      import('./agent/agentDatabase'),
      import('./agent/agentFactory'),
      import('./config/appConfig')
    ])
    await appConfig.initializeAppProfile()
    const providerConfig = await appConfig.saveModelProvider({
      name: 'Packaged smoke',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://127.0.0.1:9/v1',
      modelListUrl: '{base_url}/models',
      modelListAuth: 'bearer',
      apiKey: 'packaged-smoke-key',
      parameters: {}
    })
    const provider = providerConfig.providers.at(-1)
    if (!provider) throw new Error('Packaged Agent smoke did not create its model provider.')
    const modelConfig = await appConfig.saveProviderModel({
      providerId: provider.id,
      displayName: 'Packaged smoke',
      model: 'packaged-smoke',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: false, toolUse: true },
      stream: true,
      maxContextTokens: 16_000,
      maxOutputTokens: 2_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })
    const smokeModel = modelConfig.providers.find((entry) => entry.id === provider.id)?.models.at(-1)
    if (!smokeModel) throw new Error('Packaged Agent smoke did not create its model configuration.')
    const database = AgentDatabase.open(':memory:', join(root, 'attachments'))
    try {
      const thread = database.createThread({ title: 'Packaged smoke', modelConfigId: smokeModel.id })
      const run = database.createRun(thread.id, 'Packaged runtime assembly smoke')
      const instance = await createAgentInstance(thread, database, {
        requestId: run.id,
        prepareWorkspace: false
      })
      try {
        if (!instance.agent || database.getThread(thread.id)?.id !== thread.id) {
          throw new Error('Packaged Agent smoke did not create its runtime state.')
        }
      } finally {
        await instance.dispose()
      }
      process.stdout.write('ANAS_PACKAGED_SMOKE_OK\n')
    } finally {
      database.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
