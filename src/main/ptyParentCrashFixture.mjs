import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'vite'

const options = JSON.parse(process.argv[2])
const server = await createServer({ root: process.cwd(), cacheDir: options.cache, configFile: false,
  appType: 'custom', logLevel: 'error', server: { middlewareMode: true }, resolve: { alias: { '@shared': resolve('src/shared') } } })
const { PtyShellSupervisor } = await server.ssrLoadModule('/src/main/ptyShellSupervisor.ts')
const supervisor = new PtyShellSupervisor(options.program, { columns: 90, rows: 25 })
const source = `require('node:fs').writeFileSync(${JSON.stringify(options.childIdentity)},String(process.pid));process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});console.log('CRASH_READY');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(options.marker)},'orphaned'),4000);setInterval(()=>{},1000)`
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`
const command = `${quote(process.execPath)} -e ${quote(source)}${options.mode === 'background' ? ' &' : ';'} wait`
supervisor.on('error', (error) => { console.error(error); process.exit(2) })
supervisor.on('message', (message) => {
  if (message.type === 'ready') supervisor.send({ type: 'start',
    executable: options.mode === 'direct' ? process.execPath : process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash',
    args: options.mode === 'direct' ? ['-e', source] : ['-f', '-ic', command],
    cwd: options.root, environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeoutMs: 8000 })
  if (message.type === 'dispatching') supervisor.send({ type: 'dispatch' })
  if (message.type === 'output' && message.text.includes('CRASH_READY')) {
    writeFileSync(options.identity, String(supervisor.pid))
    process.kill(process.pid, 'SIGKILL')
  }
})
