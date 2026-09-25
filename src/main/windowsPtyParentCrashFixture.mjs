import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { createServer } from 'vite'

const options = JSON.parse(process.argv[2])
const server = await createServer({ root: process.cwd(), cacheDir: options.cache, configFile: false,
  appType: 'custom', logLevel: 'error', server: { middlewareMode: true }, resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [{ name: 'isolated-probe-logger', enforce: 'pre',
    resolveId(id) { if (/[/\\]runtimeLogger(?:\.ts)?$/.test(id)) return '\0probe-logger' },
    load(id) { if (id === '\0probe-logger') return 'export function runtimeLog() {}' }
  }] })
const { runPreparedProcess } = await server.ssrLoadModule('/src/main/shellRuntime.ts')
// Losing the test runner must also close this application's owned Job.
process.once('disconnect', () => process.kill(process.pid, 'SIGKILL'))
const crash = setInterval(() => {
  if (!existsSync(options.captured)) return
  clearInterval(crash)
  // Acknowledge the intended hard crash before exiting, so an earlier setup or
  // timeout failure cannot satisfy the containment assertion.
  process.send({ type: 'crashing' }, () => process.kill(process.pid, 'SIGKILL'))
}, 10)
await runPreparedProcess({
  command: 'Windows PTY crash fixture', workingDir: options.root, timeoutSec: 10,
  pty: { columns: 90, rows: 25 }, invocation: { executable: options.executable, args: ['-e', options.source], windowsHide: true },
  logScope: 'test', successMessage: 'done', failureMessage: 'failed',
  abortBeforeStartError: 'not started', abortError: 'cancelled', timeoutError: 'timeout'
})
clearInterval(crash)
await server.close()
process.exit(2)
