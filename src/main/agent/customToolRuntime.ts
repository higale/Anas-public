import { DynamicStructuredTool, ToolInputParsingException } from '@langchain/core/tools'
import { stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { maxCustomToolInputBytes, maxCustomToolOutputChars, parseCustomToolCommand, type CustomToolDefinition } from '@shared/customTools'
import { runPreparedProcess, type ShellRunResult } from '../shellRuntime'
import { withToolPackageDirectory } from '../toolsStore'
import { currentToolExecution } from './toolExecutionContext'
import { discoverPython3 } from '../runtimeDiscovery'

export function createCustomTools(definitions: readonly CustomToolDefinition[], options: {
  env: NodeJS.ProcessEnv
  backgroundTools: boolean
  signal?: AbortSignal
  preview?: boolean
}) {
  return definitions.filter((definition) => !definition.interactive || options.backgroundTools).map((definition) => new DynamicStructuredTool({
    name: definition.name,
    description: definition.description + (definition.interactive
      ? ' Starts an interactive terminal. stdout/stderr are merged terminal text and may contain control sequences. If still running after 10 seconds, use read_call to obtain terminal_id and read_call_output to read prompts, then write_call to send input. The configured timeout includes time waiting for input.'
      : ''),
    schema: definition.inputSchema,
    verboseParsingErrors: true,
    metadata: { anasCustomToolId: definition.id },
    func: async (args: Record<string, unknown>) => {
      if (options.preview) throw new Error('Custom tool execution is unavailable in a preview.')
      const json = JSON.stringify(args)
      if (Buffer.byteLength(json, 'utf8') > maxCustomToolInputBytes) throw new ToolInputParsingException('Custom tool arguments exceed 1 MiB. Reduce the submitted data.')
      return withToolPackageDirectory(definition, async directory => {
        const command = parseCustomToolCommand(definition.command)
        const packagePath = (value: string) => value.replaceAll('{{tool_dir}}', directory)
        let invocation = { executable: packagePath(command.executable), args: command.args.map((arg) => arg === '{{args}}' ? json : packagePath(arg)), windowsHide: true }
        const control = currentToolExecution()
        if (definition.interactive && !control?.setTerminal) throw new Error('Interactive custom tools require managed terminal execution.')
        const signal = control?.signal ?? options.signal
        signal?.throwIfAborted()
        const failure = (error: string, extra?: Record<string, unknown>) => {
          control?.setOutcome({ ok: false, error })
          return JSON.stringify({ ok: false, error, ...extra })
        }
        // Probe and execution share the same environment, including the effective .env.
        const env = { ...process.env, ...options.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
        if (extname(invocation.executable).toLowerCase() === '.py') {
          const script = resolve(directory, invocation.executable)
          try {
            if (!(await stat(script)).isFile()) return failure(`Python script is not a regular file: ${script}`)
          } catch (error) {
            signal?.throwIfAborted()
            return failure(`Cannot access Python script ${script}: ${error instanceof Error ? error.message : String(error)}`)
          }
          const python = await discoverPython3({ env, cwd: directory, signal, cache: true })
          if (!python) return failure('No usable Python 3 interpreter was found. Install Python 3 and add it to PATH, or specify its executable explicitly in the tool command.')
          invocation = { ...invocation, executable: python.executable, args: [script, ...invocation.args] }
        }
        signal?.throwIfAborted()
        let result: ShellRunResult | undefined
        await runPreparedProcess({
          command: definition.name,
          workingDir: directory,
          timeoutSec: definition.timeoutSeconds,
          maxStdoutChars: maxCustomToolOutputChars,
          invocation,
          ...(definition.interactive ? { pty: { columns: 80, rows: 24 } } : {}),
          env,
          effectSource: { customToolId: definition.id, command: definition.command },
          logScope: 'custom-tool',
          successMessage: 'Custom tool command completed.', failureMessage: 'Custom tool command failed.',
          abortBeforeStartError: 'Custom tool cancelled before execution.',
          abortError: 'Custom tool cancelled. Its effects may already have occurred.',
          timeoutError: 'Custom tool timed out. Its effects may already have occurred.'
        }, signal, {
          onDispatched: control?.markRunning,
          onOutcomeUncertain: control?.markUncertain,
          onOutput: control?.output,
          onTerminal: control?.setTerminal,
          onResult: (value) => { result = value; control?.setOutcome({ ok: value.ok, exit_code: value.exitCode, timed_out: value.timedOut, aborted: value.aborted }) }
        })
        if (!result) return failure('Custom tool ended before returning a result.')
        if (!result.ok) return failure(result.error ?? `Command exited with code ${result.exitCode}.`, {
          stdout: result.stdout, stderr: result.stderr, exit_code: result.exitCode, truncated: result.truncated
        })
        if (result.truncated?.stdout) return result.stdout + `\n\n[Output truncated at ${maxCustomToolOutputChars.toLocaleString('en-US')} characters. The command completed; do not repeat it solely to retrieve omitted output, as its effects may already have occurred.]`
        return result.stdout
      })
    }
  }))
}
