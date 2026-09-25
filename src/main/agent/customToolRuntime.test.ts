import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { EOL, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { customToolDefaults, maxCustomToolOutputChars, parseCustomTools, validateCustomTool, type CustomToolDefinition } from '@shared/customTools'
import { ToolMessage } from '@langchain/core/messages'
import { createCustomTools } from './customToolRuntime'
import { validateAgentToolInput } from './toolInputErrors'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { withManagedToolExecution } from './managedToolExecution'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { createRuntimeTools } from '../llm/runtimeTools'
import * as runtimeDiscovery from '../runtimeDiscovery'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))) })

async function fixture(source: string, overrides: Partial<CustomToolDefinition> = {}, signal?: AbortSignal) {
  const directory = await mkdtemp(join(tmpdir(), 'anas-custom-tool-'))
  directories.push(directory)
  const scriptPath = join(directory, 'script with spaces.cjs')
  await writeFile(scriptPath, source)
  const definition: CustomToolDefinition = { ...customToolDefaults, id: 'custom', name: 'submit_result', description: 'Submit structured data.', directory,
    command: `"${process.platform === 'win32' ? process.env.npm_node_execpath : process.execPath}" "script with spaces.cjs" --mode validate --data {{args}} --verbose`,
    inputSchema: { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false }, ...overrides }
  const snapshots = structuredClone([validateCustomTool(definition)])
  const [tool] = createCustomTools(snapshots, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, backgroundTools: true, signal })
  return { tool, definition, snapshots, directory, scriptPath }
}

describe('custom command tools', () => {
  it.each(['entry with spaces.py', '{{tool_dir}}/entry with spaces.py'])('resolves %s to the discovered interpreter and passes arguments and environment intact', async entry => {
    const { directory, definition } = await fixture('')
    const script = join(directory, 'entry with spaces.py')
    // Stand-in interpreter: Node accepts a .py entry as a CommonJS script.
    await writeFile(script, 'process.stdout.write(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),marker:process.env.ANAS_CUSTOM_MARKER}))')
    const discover = vi.spyOn(runtimeDiscovery, 'discoverPython3').mockResolvedValue({ executable: process.execPath, version: '3.13.3', command: 'python3' })
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANAS_CUSTOM_MARKER: 'tool environment' }
    const [tool] = createCustomTools([{ ...definition, command: `"${entry}" --fixed "with spaces" {{args}}` }], { env, backgroundTools: false })
    const args = { title: '中文 "quote"\r\n$() & {{tool_dir}}' }
    expect(JSON.parse(await tool.invoke(args))).toEqual({ argv: ['--fixed', 'with spaces', JSON.stringify(args)], cwd: await realpath(directory), marker: 'tool environment' })
    expect(discover.mock.calls[0][0]?.cwd).toBe(await realpath(directory))
    expect(discover.mock.calls[0][0]?.env?.ANAS_CUSTOM_MARKER).toBe('tool environment')
  })
  it('does not discover an interpreter for explicit commands, missing scripts or directory entries', async () => {
    const { directory, definition, tool } = await fixture('process.stdout.write("explicit")')
    const discover = vi.spyOn(runtimeDiscovery, 'discoverPython3')
    expect(await tool.invoke({ title: 'test' })).toBe('explicit')
    const [missing] = createCustomTools([{ ...definition, command: 'missing.py {{args}}' }], { env: process.env, backgroundTools: false })
    expect(JSON.parse(await missing.invoke({ title: 'test' }))).toMatchObject({ ok: false, error: expect.stringContaining('Cannot access Python script') })
    await mkdir(join(directory, 'folder.py'))
    const [folder] = createCustomTools([{ ...definition, command: 'folder.py {{args}}' }], { env: process.env, backgroundTools: false })
    expect(JSON.parse(await folder.invoke({ title: 'test' }))).toMatchObject({ ok: false, error: expect.stringContaining('not a regular file') })
    expect(discover).not.toHaveBeenCalled()
  })
  it('reports missing Python and honours cancellation before dispatch', async () => {
    const { directory, definition } = await fixture('')
    await writeFile(join(directory, 'entry.py'), 'require("fs").writeFileSync("executed", "yes")')
    const discover = vi.spyOn(runtimeDiscovery, 'discoverPython3').mockResolvedValue(undefined)
    const controller = new AbortController()
    const [tool] = createCustomTools([{ ...definition, command: 'entry.py {{args}}' }], { env: process.env, backgroundTools: false, signal: controller.signal })
    expect(JSON.parse(await tool.invoke({ title: 'test' }))).toMatchObject({ ok: false, error: expect.stringContaining('No usable Python 3') })
    discover.mockImplementation(async () => { controller.abort(); return { executable: process.execPath, version: '3.13.3', command: 'python3' } })
    await expect(tool.invoke({ title: 'test' })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readFile(join(directory, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('runs bundled script-only examples with a real Python when installed', async ({ skip }) => {
    if (!await runtimeDiscovery.discoverPython3()) return skip()
    const { directory } = await fixture('')
    const definitions = await Promise.all(['read_text_raw', 'file_sha256', 'json_format'].map(async name => {
      const packageDirectory = resolve('data/tools_examples', name)
      return { ...parseCustomTools([JSON.parse(await readFile(join(packageDirectory, 'TOOL.json'), 'utf8'))])[0], directory: packageDirectory }
    }))
    const [raw, hash, format] = createCustomTools(definitions, { env: process.env, backgroundTools: false })
    const path = join(directory, '中文 text.txt')
    for (const content of ['', 'x'.repeat(512 * 1024), '\uFEFF中文🙂\r\nno trailing newline']) {
      await writeFile(path, content)
      expect(await raw.invoke({ path })).toBe(content)
    }
    const content = await readFile(path)
    expect(JSON.parse(await hash.invoke({ path }))).toEqual({ path, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') })
    expect(await format.invoke({ value: { b: 2, a: '中文' }, sort_keys: true })).toBe(['{', '  "a": "中文",', '  "b": 2', '}'].join(EOL))
    for (const invalid of [Buffer.alloc(512 * 1024 + 1, 'x'), Buffer.from([0xff])]) {
      await writeFile(path, invalid)
      expect(JSON.parse(await raw.invoke({ path }))).toMatchObject({ ok: false, stdout: '', stderr: expect.any(String) })
    }
  })
  it.each(['script with spaces.cjs', '{{tool_dir}}/script with spaces.cjs'])('runs %s in its package directory and leaves JSON placeholders literal', async script => {
    const packageFixture = await fixture('process.stdout.write(JSON.stringify({cwd:process.cwd(),resource:require("node:fs").readFileSync("data.txt","utf8"),args:JSON.parse(process.argv[2])}))')
    await writeFile(join(packageFixture.directory, 'data.txt'), 'package resource')
    const definition = { ...packageFixture.definition,
      command: `"${process.platform === 'win32' ? process.env.npm_node_execpath : process.execPath}" "${script}" {{args}}` }
    const [tool] = createCustomTools([definition], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, backgroundTools: false })
    const args = { title: '{{tool_dir}} / {{args}} 中文 "quote"' }
    expect(JSON.parse(await tool.invoke(args))).toEqual({ cwd: await realpath(packageFixture.directory), resource: 'package resource', args })
  })
  it('refuses execution without a package directory', async () => {
    const { tool } = await fixture('', { directory: undefined })
    await expect(tool.invoke({ title: 'test' })).rejects.toThrow('Tool package is unavailable')
  })
  it('omits interactive tools when background tools are disabled while retaining ordinary tools', async () => {
    const { snapshots } = await fixture('')
    const definitions = [...snapshots, { ...snapshots[0], id: 'interactive', name: 'interactive_tool', interactive: true }]
    expect(createCustomTools(definitions, { env: {}, backgroundTools: false }).map((tool) => tool.name)).toEqual(['submit_result'])
  })
  it('returns a background terminal, reads its prompt and sends input without Shell capability', async () => {
    const { tool } = await fixture(`const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout});console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY);console.error('DIAGNOSTIC');rl.question('PROMPT:',answer=>{console.log('ANSWER:'+answer);rl.close()})`, { interactive: true })
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'interactive-run')
    const service = new ManagedCallService(database)
    try {
      const managed = withManagedToolExecution(tool, { database, service, threadId: thread.id, runId: run.id, allowBackground: true })
      const result = await managed.invoke({ type: 'tool_call', id: 'interactive-call', name: tool.name, args: { title: 'test' } }) as ToolMessage
      const { call_id: callId } = JSON.parse(String(result.content))
      expect(callId).toBeTruthy()
      const status = JSON.parse(service.read({ callId, threadId: thread.id }))
      expect(status.pty.terminal_id).toBeTruthy()
      const output = service.readOutput({ callId, threadId: thread.id, offset: 0, length: 1000 })
      expect(output).toContain('TTY:true:true')
      expect(output).toContain('PROMPT:')
      expect(output).toContain('DIAGNOSTIC')
      const tools = await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), memory: false,
        network: false, shell: false, mcp: false, backgroundTools: true, interactiveCustomTools: true,
        managedCalls: service, threadId: thread.id, toolNames: [] })
      const write = tools.find((tool) => tool.name === 'write_call')!
      const target = { call_id: callId, terminal_id: status.pty.terminal_id }
      await expect(service.writeTerminal(callId, thread.id, 'stale-id', { type: 'text', text: 'wrong' })).rejects.toThrow('unavailable')
      await write.invoke({ ...target, action: { type: 'resize', columns: 100, rows: 30 } })
      await write.invoke({ ...target, action: { type: 'text', text: '你好 terminal' } })
      await write.invoke({ ...target, action: { type: 'key', key: 'enter' } })
      await service.waitForIdle()
      expect(JSON.parse(service.read({ callId, threadId: thread.id })).status).toBe('completed')
      expect((await service.readResult(callId, thread.id))?.content).toContain('ANSWER:你好 terminal')
      await expect(write.invoke({ ...target, action: { type: 'text', text: 'stale' } })).rejects.toThrow('unavailable')
    } finally { await service.shutdown(); database.close() }
  }, 25_000)
  it('delivers trailing Windows separators, quoted fixed arguments and JSON intact to the process', async () => {
    const { tool } = await fixture('console.log(JSON.stringify(process.argv.slice(2)))', {
      command: `"${process.execPath}" "script with spaces.cjs" --output "C:\\data\\" --label "daily report" {{args}} --other "\\\\server\\share\\" --empty ""`
    })
    const args = { title: '中文 "quoted"\n\\ {{args}} & $()' }
    expect(JSON.parse(await tool.invoke(args))).toEqual([
      '--output', 'C:\\data\\', '--label', 'daily report', JSON.stringify(args), '--other', '\\\\server\\share\\', '--empty', ''
    ])
  })
  it('delivers JSON as one argument surrounded by fixed arguments, in the package folder', async () => {
    const { tool, directory } = await fixture(`console.error('diagnostic');console.log(JSON.stringify({ok:true,data:JSON.parse(process.argv[5]),fixed:process.argv.slice(2,5).concat(process.argv.slice(6)),cwd:process.cwd()}))`)
    const args = { title: '中文 "quotes"\r\n$() & `literal` \\ {{args}}' }
    expect(JSON.parse(await tool.invoke(args))).toEqual({ ok: true, data: args, fixed: ['--mode', 'validate', '--data', '--verbose'], cwd: await realpath(directory) })
    expect(classifyAgentToolEffect(tool.name, args, tool)).toEqual({ recoveryMode: 'confirm' })
  })
  it('rejects invalid input before invoking a script, allowing model correction', async () => {
    const { tool, directory } = await fixture(`require('fs').writeFileSync('executed','yes');console.log('{"ok":true}')`)
    await expect(validateAgentToolInput(tool, { title: 12 })).rejects.toThrow('string')
    await expect(tool.invoke({ title: 12 })).rejects.toThrow()
    await expect(readFile(join(directory, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it.each([
    [`console.error('specific failure');process.exit(2)`, { ok: false, exit_code: 2, stderr: expect.stringContaining('specific failure') }],
    [`console.log('VALIDATION_DETAIL: customer does not exist');process.exit(2)`, { ok: false, exit_code: 2, stdout: expect.stringContaining('VALIDATION_DETAIL') }],
    [`console.log('detail-'+'x'.repeat(${maxCustomToolOutputChars + 1}));process.exitCode=2`, { ok: false, stdout: expect.stringMatching(/^detail-/), truncated: { stdout: true } }],
    [`console.error('detail-'+'x'.repeat(130000));process.exitCode=2`, { ok: false, stderr: expect.stringMatching(/^detail-/), truncated: { stderr: true } }]
  ])('retains diagnostics on execution failure independently of stdout content', async (source, expected) => {
    const { tool } = await fixture(source)
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'failure-run')
    const service = new ManagedCallService(database)
    try {
      const managed = withManagedToolExecution(tool, { database, service, threadId: thread.id, runId: run.id, allowBackground: false })
      const result = await managed.invoke({ type: 'tool_call', id: 'failure-call', name: tool.name, args: { title: 'test' } }) as ToolMessage
      expect(result.status).toBe('error')
      expect(JSON.parse(String(result.content))).toMatchObject(expected)
    } finally { await service.shutdown(); database.close() }
  })
  it.each(['ascii', 'utf8'])('delivers a complete large %s file through the managed tool result', async encoding => {
    const output = encoding === 'ascii' ? 'x'.repeat(512 * 1024) : '\uFEFF' + '中文🙂\r\n'.repeat(40000) + 'EOF'
    const { tool, directory } = await fixture('process.stdout.write(require("node:fs").readFileSync("content.txt"))')
    await writeFile(join(directory, 'content.txt'), output)
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'complete-run')
    const service = new ManagedCallService(database)
    try {
      const managed = withManagedToolExecution(tool, { database, service, threadId: thread.id, runId: run.id, allowBackground: false })
      const result = await managed.invoke({ type: 'tool_call', id: 'complete-call', name: tool.name, args: { title: 'test' } }) as ToolMessage
      expect(result.status).toBe('success')
      expect(result.content).toBe(output)
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(false)
    } finally { await service.shutdown(); database.close() }
  })
  it('returns bounded stdout and an explicit truncation notice without changing successful execution to failure', async () => {
    const { tool } = await fixture(`process.stdout.write('RESULT_BEGIN'+'x'.repeat(${maxCustomToolOutputChars})+'RESULT_END')`)
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'truncated-run')
    const service = new ManagedCallService(database)
    try {
      const managed = withManagedToolExecution(tool, { database, service, threadId: thread.id, runId: run.id, allowBackground: false })
      const result = await managed.invoke({ type: 'tool_call', id: 'truncated-call', name: tool.name, args: { title: 'test' } }) as ToolMessage
      expect(result.status).toBe('success')
      expect(String(result.content)).toMatch(/^RESULT_BEGINx+/)
      expect(String(result.content)).toContain('[Output truncated at 524,288 characters.')
      expect(String(result.content)).not.toContain('RESULT_END')
      expect(String(result.content).length).toBeLessThan(maxCustomToolOutputChars + 1000)
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(false)
    } finally { await service.shutdown(); database.close() }
  })
  it.each(['已接收标题\n第二行', '{not-json}', '{"accepted":1}', '{"ok":false,"error":"title must be unique"}', '["first","second"]', ''])('returns arbitrary stdout verbatim: %s', async (output) => {
    const { tool } = await fixture(`process.stdout.write(${JSON.stringify(output)})`)
    expect(await tool.invoke({ title: 'test' })).toBe(output)
  })
  it('uses the same 2019-09 reference sibling semantics in preflight and native execution', async () => {
    const { tool, directory } = await fixture(`require('fs').writeFileSync('executed','yes');console.log('accepted')`, {
      inputSchema: { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object',
        $defs: { count: { type: 'integer' } }, properties: { count: { $ref: '#/$defs/count', minimum: 2 } }, required: ['count'] }
    })
    await expect(validateAgentToolInput(tool, { count: 1 })).rejects.toThrow()
    await expect(tool.invoke({ count: 1 })).rejects.toThrow()
    await expect(readFile(join(directory, 'executed'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(validateAgentToolInput(tool, { count: 2 })).resolves.toBeUndefined()
    expect(await tool.invoke({ count: 2 })).toContain('accepted')
  })
  it('returns missing executable errors to the model instead of blocking run creation', async () => {
    const { tool } = await fixture('', { command: 'anas-executable-that-does-not-exist {{args}}' })
    expect(JSON.parse(await tool.invoke({ title: 'test' }))).toMatchObject({ ok: false, error: expect.stringContaining('ENOENT') })
  })
  it.each([false, true].flatMap(interactive => (['cancel', 'timeout'] as const).map(mode => ({ mode, interactive }))))('confirms script and child termination on $mode (interactive=$interactive)', async ({ mode, interactive }) => {
    const controller = new AbortController()
    const { tool, directory } = await fixture(`const child=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:process.env,stdio:'ignore'});require('fs').writeFileSync('pids.json',JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000)`, { interactive, timeoutSeconds: mode === 'timeout' ? 2 : 0 }, controller.signal)
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Custom script cancellation' })
    const run = database.createRun(thread.id, 'custom-run')
    const service = new ManagedCallService(database)
    const managed = withManagedToolExecution(tool, { database, service, threadId: thread.id, runId: run.id, allowBackground: interactive, signal: controller.signal })
    let pending: Promise<unknown> | undefined
    try {
      pending = managed.invoke({ type: 'tool_call', id: 'test-call', name: managed.name, args: { title: 'test' } })
      let pids: number[] = []
      await expect.poll(async () => {
        try { pids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')); return pids.length } catch { return 0 }
      }, { timeout: 5000 }).toBe(2)
      if (mode === 'cancel') controller.abort()
      const result = await pending as ToolMessage
      expect(ToolMessage.isInstance(result)).toBe(true)
      expect(result.content).toContain('false')
      await expect.poll(() => pids.every((pid) => { try { process.kill(pid, 0); return false } catch { return true } }), { timeout: 5000 }).toBe(true)
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(false)
    } finally { controller.abort(); await pending?.catch(() => undefined); await service.shutdown(); database.close() }
  })
})
