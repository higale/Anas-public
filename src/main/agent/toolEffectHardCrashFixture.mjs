import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const [, , serializedOptions] = process.argv
if (!serializedOptions) throw new Error('Expected serialized hard-crash fixture options.')
const options = JSON.parse(serializedOptions)

const server = await createServer({
  root: process.cwd(),
  cacheDir: options.viteCacheDirectory,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      electron: fileURLToPath(new URL('./toolEffectHardCrashElectronShim.mjs', import.meta.url))
    }
  }
})

try {
  if (options.scenario === 'file_patch_store') {
    const harness = await server.ssrLoadModule('/src/main/filePatchRecordCrashHarness.ts')
    await harness.runFilePatchRecordCrashHarness(options)
    throw new Error('Patch fixture did not reach its requested crash boundary.')
  }
  const harness = await server.ssrLoadModule(
    '/src/main/agent/toolEffectHardCrashHarness.ts'
  )
  const output = await harness.runToolEffectHardCrashHarnessFromFile(options)
  process.stdout.write(`ANAS_HARD_CRASH_RESULT:${JSON.stringify(output)}\n`)
} finally {
  await server.close()
}
process.exit(0)
