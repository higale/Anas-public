import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./config/apiKeys', () => ({
  loadDataEnv: vi.fn()
}))

vi.mock('./runtimeLogger', () => ({
  runtimeLog: vi.fn()
}))

import {
  describeCommandShell,
  describeCommandShellArgument,
  describeCommandShellTool,
  prepareShellCommand,
  resolveCommandShell,
  resolveShellInvocation,
  resultText,
  runPreparedProcess,
  runShellCommand,
  shellSupervisorProgram,
  type ShellRunCallbacks,
  type ShellRunResult
} from './shellRuntime'
import { runWithCurrentAgentToolEffect, type AgentToolEffectArm } from './agent/toolEffectScope'
import { commandShellToolName } from '@shared/commandShell'

describe('shell runtime result text', () => {
  it('serializes the full result object for non-stdout-only results', () => {
    const result = {
      ok: false,
      command: 'echo secret',
      workingDir: '/tmp',
      timeoutSec: 30,
      stdout: '',
      stderr: '',
      error: 'denied',
      user_guidance: 'try another command'
    } satisfies ShellRunResult & { user_guidance: string }

    expect(JSON.parse(resultText(result))).toEqual(result)
  })

  it('keeps raw stdout for simple successful output', () => {
    expect(resultText({
      ok: true,
      command: 'printf hello',
      workingDir: '/tmp',
      timeoutSec: 30,
      stdout: 'hello',
      stderr: ''
    })).toBe('hello')
  })

  it('resolves a relative working directory from the default working directory', async () => {
    const defaultWorkingDir = process.cwd()
    await expect(prepareShellCommand({
      command: 'pwd',
      workingDir: '.'
    }, defaultWorkingDir)).resolves.toMatchObject({
      command: 'pwd',
      workingDir: defaultWorkingDir,
      timeoutSec: 0,
      keepProcesses: false
    })
  })

  it('preserves command text verbatim when preparing execution', async () => {
    const command = '\n  # original comment\nGet-Content notes.txt  \n'
    const input = Object.freeze({ command })
    expect(await prepareShellCommand(input, process.cwd())).toMatchObject({ command })
    expect(input.command).toBe(command)
  })

  it('preserves an explicit request to keep child processes', async () => {
    const defaultWorkingDir = process.cwd()
    await expect(prepareShellCommand({
      command: 'Start-Process calc',
      keepProcesses: true
    }, defaultWorkingDir)).resolves.toMatchObject({
      command: 'Start-Process calc',
      workingDir: defaultWorkingDir,
      timeoutSec: 0,
      keepProcesses: true
    })
  })

  it('forwards complete process output while bounding only the inline result', async () => {
    const expected = 'x'.repeat(200_000)
    const streamed: string[] = []
    const outcomes: ShellRunResult[] = []
    const output = await runPreparedProcess({
      command: 'complete output probe',
      workingDir: process.cwd(),
      timeoutSec: 0,
      invocation: {
        executable: process.execPath,
        args: ['-e', `process.stdout.write('x'.repeat(${expected.length}))`],
        windowsHide: true,
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      logScope: 'test',
      successMessage: 'Complete output probe finished.',
      failureMessage: 'Complete output probe failed.',
      abortBeforeStartError: 'Complete output probe was cancelled before it started.',
      abortError: 'Complete output probe was cancelled.',
      timeoutError: 'Complete output probe timed out.'
    }, undefined, {
      onOutput: (_stream, text) => streamed.push(text),
      onResult: (result) => outcomes.push(result)
    })

    expect(streamed.join('')).toBe(expected)
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      stdout: 'x'.repeat(120_000),
      truncated: { stdout: true }
    })
    expect(outcomes).toHaveLength(1)
  })

  it('preserves multibyte UTF-8 characters across child output chunks', async () => {
    const unit = '日・本'
    const repetitions = 20_000
    const effects: AgentToolEffectArm[] = []
    const output = await runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => runPreparedProcess({
      command: 'unicode probe',
      workingDir: process.cwd(),
      timeoutSec: 30,
      invocation: {
        executable: process.execPath,
        args: ['-e', `process.stdout.write('${unit}'.repeat(${repetitions}))`],
        windowsHide: true,
        env: { ELECTRON_RUN_AS_NODE: '1' }
      },
      logScope: 'test',
      successMessage: 'Unicode probe finished.',
      failureMessage: 'Unicode probe failed.',
      abortBeforeStartError: 'Unicode probe was cancelled before it started.',
      abortError: 'Unicode probe was cancelled.',
      timeoutError: 'Unicode probe timed out.'
    }))

    expect(output).toBe(unit.repeat(repetitions))
    expect(effects).toEqual([expect.objectContaining({
      kind: 'process_spawn',
      target: expect.objectContaining({
        command: 'unicode probe',
        environmentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    })])
  })

  it('binds a recovered process attempt to the effective environment snapshot', async () => {
    const effects: AgentToolEffectArm[] = []
    const previous = process.env.ANAS_EFFECT_ENV_TEST
    const invoke = async (value: string): Promise<void> => {
      process.env.ANAS_EFFECT_ENV_TEST = value
      await runWithCurrentAgentToolEffect({
        arm: (effect) => effects.push(effect)
      }, () => runPreparedProcess({
        command: 'environment fingerprint probe',
        workingDir: process.cwd(),
        timeoutSec: 30,
        invocation: {
          executable: process.execPath,
          args: ['-e', 'process.stdout.write("ok")'],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Environment probe finished.',
        failureMessage: 'Environment probe failed.',
        abortBeforeStartError: 'Environment probe was cancelled before it started.',
        abortError: 'Environment probe was cancelled.',
        timeoutError: 'Environment probe timed out.'
      }))
    }

    try {
      await invoke('first-target')
      await invoke('second-target')
    } finally {
      if (previous === undefined) delete process.env.ANAS_EFFECT_ENV_TEST
      else process.env.ANAS_EFFECT_ENV_TEST = previous
    }

    const fingerprints = effects.map((effect) => (
      effect.target as { environmentFingerprint: string }
    ).environmentFingerprint)
    expect(fingerprints).toHaveLength(2)
    expect(fingerprints[0]).not.toBe(fingerprints[1])
  })

  it('does not spawn when cancellation arrives while the durable effect is armed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-abort-race-'))
    const marker = join(root, 'spawned.txt')
    const controller = new AbortController()
    try {
      const output = await runWithCurrentAgentToolEffect({
        arm: () => controller.abort()
      }, () => runPreparedProcess({
        command: 'abort race probe',
        workingDir: root,
        timeoutSec: 30,
        invocation: {
          executable: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Abort race probe finished.',
        failureMessage: 'Abort race probe failed.',
        abortBeforeStartError: 'Abort race probe was cancelled before it started.',
        abortError: 'Abort race probe was cancelled.',
        timeoutError: 'Abort race probe timed out.'
      }, controller.signal))

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        aborted: true,
        error: 'Abort race probe was cancelled before it started.'
      })
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([false, true])(
    'enforces the command timeout inside the supervisor process when keepProcesses is %s',
    async (keepProcesses) => {
      const output = await runPreparedProcess({
        command: 'supervisor timeout probe',
        workingDir: process.cwd(),
        timeoutSec: 0.05,
        keepProcesses,
        invocation: {
          executable: process.execPath,
          args: ['-e', 'setTimeout(() => process.stdout.write("too late"), 1000)'],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Timeout probe finished.',
        failureMessage: 'Timeout probe failed.',
        abortBeforeStartError: 'Timeout probe was cancelled before it started.',
        abortError: 'Timeout probe was cancelled.',
        timeoutError: 'Timeout probe timed out.'
      })

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        timedOut: true,
        error: 'Timeout probe timed out.'
      })
    }
  )

  it.runIf(process.platform !== 'win32')('preserves a precise timeout while force-killing a stubborn process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-stubborn-timeout-'))
    const marker = join(root, 'survived.txt')
    try {
      const output = await runPreparedProcess({
        command: 'stubborn timeout probe',
        workingDir: root,
        timeoutSec: 0.05,
        invocation: {
          executable: process.execPath,
          args: ['-e', [
            `process.on('SIGTERM', () => {})`,
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 3000)`
          ].join(';')],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Stubborn timeout probe finished.',
        failureMessage: 'Stubborn timeout probe failed.',
        abortBeforeStartError: 'Stubborn timeout probe was cancelled before it started.',
        abortError: 'Stubborn timeout probe was cancelled.',
        timeoutError: 'Stubborn timeout probe timed out.'
      })

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        timedOut: true,
        aborted: false,
        error: 'Stubborn timeout probe timed out.'
      })
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32')('force-kills a stubborn descendant after its command process exits gracefully', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-stubborn-descendant-'))
    const readyMarker = join(root, 'descendant-ready.txt')
    const survivedMarker = join(root, 'descendant-survived.txt')
    const controller = new AbortController()
    try {
      const output = await runPreparedProcess({
        command: 'stubborn descendant cancellation probe',
        workingDir: root,
        timeoutSec: 30,
        invocation: {
          executable: process.execPath,
          args: ['-e', [
            `const { spawn } = require('node:child_process')`,
            `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify([
              `process.on('SIGTERM', () => {})`,
              `require('node:fs').writeFileSync(${JSON.stringify(readyMarker)}, 'ready')`,
              `process.send('ready')`,
              `process.disconnect()`,
              `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(survivedMarker)}, 'survived'), 2000)`
            ].join(';'))}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })`,
            `descendant.once('message', () => process.stdout.write('descendant-ready'))`,
            `descendant.unref()`,
            `setTimeout(() => {}, 10_000)`
          ].join(';')],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Stubborn descendant probe finished.',
        failureMessage: 'Stubborn descendant probe failed.',
        abortBeforeStartError: 'Stubborn descendant probe was cancelled before it started.',
        abortError: 'Stubborn descendant probe was cancelled.',
        timeoutError: 'Stubborn descendant probe timed out.'
      }, controller.signal, {
        // Exercise descendant containment only after it has installed its
        // signal handler; a wall-clock startup deadline races machine load.
        onOutput: () => controller.abort()
      })

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        timedOut: false,
        aborted: true,
        error: 'Stubborn descendant probe was cancelled.'
      })
      await expect(access(readyMarker)).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 2_200))
      await expect(access(survivedMarker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      controller.abort()
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it.runIf(process.platform !== 'win32')('preserves precise cancellation while force-killing a stubborn process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-stubborn-cancel-'))
    const marker = join(root, 'survived.txt')
    const controller = new AbortController()
    try {
      const output = await runPreparedProcess({
        command: 'stubborn cancellation probe',
        workingDir: root,
        timeoutSec: 10,
        invocation: {
          executable: process.execPath,
          args: ['-e', [
            `process.on('SIGTERM', () => {})`,
            `process.stdout.write('ready')`,
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 3000)`
          ].join(';')],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Stubborn cancellation probe finished.',
        failureMessage: 'Stubborn cancellation probe failed.',
        abortBeforeStartError: 'Stubborn cancellation probe was cancelled before it started.',
        abortError: 'Stubborn cancellation probe was cancelled.',
        timeoutError: 'Stubborn cancellation probe timed out.'
      }, controller.signal, {
        onOutput: () => controller.abort()
      })

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        aborted: true,
        error: 'Stubborn cancellation probe was cancelled.'
      })
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('persists dispatch before allowing the supervisor to spawn the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-dispatch-gate-'))
    const marker = join(root, 'spawned.txt')
    let markerExistedAtDispatch: boolean | undefined
    try {
      const output = await runPreparedProcess({
        command: 'dispatch gate probe',
        workingDir: root,
        timeoutSec: 10,
        invocation: {
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Dispatch gate probe finished.',
        failureMessage: 'Dispatch gate probe failed.',
        abortBeforeStartError: 'Dispatch gate probe was cancelled before it started.',
        abortError: 'Dispatch gate probe was cancelled.',
        timeoutError: 'Dispatch gate probe timed out.'
      }, undefined, {
        onDispatched: () => {
          markerExistedAtDispatch = existsSync(marker)
        }
      })

      expect(JSON.parse(output)).toMatchObject({ ok: true, exitCode: 0 })
      expect(markerExistedAtDispatch).toBe(false)
      expect(existsSync(marker)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('cleans up descendants that outlive a normally completed command process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-result-cleanup-'))
    const marker = join(root, 'descendant-survived.txt')
    try {
      const output = await runPreparedProcess({
        command: 'completed command descendant cleanup probe',
        workingDir: root,
        timeoutSec: 10,
        invocation: {
          executable: process.execPath,
          args: ['-e', [
            `const { spawn } = require('node:child_process')`,
            `spawn(process.execPath, ['-e', ${JSON.stringify(
              `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`
            )}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }).unref()`
          ].join(';')],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Descendant cleanup probe finished.',
        failureMessage: 'Descendant cleanup probe failed.',
        abortBeforeStartError: 'Descendant cleanup probe was cancelled before it started.',
        abortError: 'Descendant cleanup probe was cancelled.',
        timeoutError: 'Descendant cleanup probe timed out.'
      })

      expect(JSON.parse(output)).toMatchObject({ ok: true, exitCode: 0 })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps descendants after a successful command only when explicitly requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-result-keep-'))
    const marker = join(root, 'descendant-survived.txt')
    try {
      const invocation = process.platform === 'win32'
        ? {
            executable: 'powershell.exe',
            args: [
              '-NoProfile',
              '-Command',
              `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-EncodedCommand','${Buffer.from(
                `Start-Sleep -Milliseconds 1200; [IO.File]::WriteAllText(${JSON.stringify(marker)}, 'survived')`,
                'utf16le'
              ).toString('base64')}')`
            ],
            windowsHide: true
          }
        : {
            executable: process.execPath,
            args: ['-e', [
              `const { spawn } = require('node:child_process')`,
              `spawn(process.execPath, ['-e', ${JSON.stringify(
                `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`
              )}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }).unref()`
            ].join(';')],
            windowsHide: true,
            env: { ELECTRON_RUN_AS_NODE: '1' }
          }
      const output = await runPreparedProcess({
        command: 'completed command descendant keep probe',
        workingDir: root,
        timeoutSec: 10,
        keepProcesses: true,
        invocation,
        logScope: 'test',
        successMessage: 'Descendant keep probe finished.',
        failureMessage: 'Descendant keep probe failed.',
        abortBeforeStartError: 'Descendant keep probe was cancelled before it started.',
        abortError: 'Descendant keep probe was cancelled.',
        timeoutError: 'Descendant keep probe timed out.'
      })

      expect(JSON.parse(output)).toMatchObject({ ok: true, exitCode: 0 })
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await expect(access(marker)).resolves.toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('cleans up descendants after a failed command even when keeping was requested', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-failed-keep-'))
    const marker = join(root, 'descendant-survived.txt')
    try {
      const output = await runPreparedProcess({
        command: 'failed command descendant cleanup probe',
        workingDir: root,
        timeoutSec: 10,
        keepProcesses: true,
        invocation: {
          executable: process.execPath,
          args: ['-e', [
            `const { spawn } = require('node:child_process')`,
            `spawn(process.execPath, ['-e', ${JSON.stringify(
              `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`
            )}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore' }).unref()`,
            `process.exitCode = 1`
          ].join(';')],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Failed descendant cleanup probe finished.',
        failureMessage: 'Failed descendant cleanup probe failed.',
        abortBeforeStartError: 'Failed descendant cleanup probe was cancelled before it started.',
        abortError: 'Failed descendant cleanup probe was cancelled.',
        timeoutError: 'Failed descendant cleanup probe timed out.'
      })

      expect(JSON.parse(output)).toMatchObject({ ok: false, exitCode: 1 })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('marks the outcome uncertain and kills the command if its supervisor exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-supervisor-exit-'))
    const marker = join(root, 'survived.txt')
    const onOutcomeUncertain = vi.fn()
    try {
      const output = await runPreparedProcess({
        command: 'supervisor failure probe',
        workingDir: root,
        timeoutSec: 10,
        invocation: {
          executable: process.execPath,
          args: [
           '-e',
           [
              `const { spawn } = require('node:child_process')`,
              `spawn(process.execPath, ['-e', ${JSON.stringify(
                `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 2500)`
              )}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })`,
              `process.kill(process.ppid, 'SIGKILL')`,
              `setTimeout(() => {}, 5000)`
            ].join(';')
          ],
          windowsHide: true,
          env: { ELECTRON_RUN_AS_NODE: '1' }
        },
        logScope: 'test',
        successMessage: 'Supervisor failure probe finished.',
        failureMessage: 'Supervisor failure probe failed.',
        abortBeforeStartError: 'Supervisor failure probe was cancelled before it started.',
        abortError: 'Supervisor failure probe was cancelled.',
        timeoutError: 'Supervisor failure probe timed out.'
      }, undefined, { onOutcomeUncertain })

      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        error: 'Command supervisor exited after dispatch was authorized; the final outcome is unknown.'
      })
      expect(onOutcomeUncertain).toHaveBeenCalledOnce()
      expect(onOutcomeUncertain).toHaveBeenCalledWith(expect.stringContaining('outcome is unknown'))
      await new Promise((resolve) => setTimeout(resolve, 2_700))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('terminates the supervised command when the parent IPC channel disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-supervisor-'))
    const marker = join(root, 'orphaned.txt')
    const supervisor = spawn(process.execPath, ['-e', shellSupervisorProgram], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    try {
      const [ready] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(ready).toMatchObject({ type: 'ready' })
      supervisor.send({
        type: 'start',
        executable: process.execPath,
        args: [
          '-e',
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 3000)`
        ],
        cwd: root,
        windowsHide: true,
        environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: 10_000
      })
      const [dispatching] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(dispatching).toMatchObject({ type: 'dispatching' })
      supervisor.send({ type: 'dispatch' })
      const [started] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(started).toMatchObject({ type: 'started' })

      const exited = once(supervisor, 'exit')
      supervisor.disconnect()
      await exited
      await new Promise((resolve) => setTimeout(resolve, 3_200))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('exits when the parent does not acknowledge timeout termination', async () => {
    const boundedSupervisorProgram = shellSupervisorProgram
      .replace('const forceKillDelayMs = 2000', 'const forceKillDelayMs = 40')
      .replace('const coordinationTimeoutMs = 5000', 'const coordinationTimeoutMs = 40')
    expect(boundedSupervisorProgram).not.toBe(shellSupervisorProgram)
    const supervisor = spawn(process.execPath, ['-e', boundedSupervisorProgram], {
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    const exited = once(supervisor, 'exit')
    try {
      const [ready] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(ready).toMatchObject({ type: 'ready' })
      supervisor.send({
        type: 'start',
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)'],
        cwd: process.cwd(),
        windowsHide: true,
        environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: 20
      })
      const [dispatching] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(dispatching).toMatchObject({ type: 'dispatching' })
      supervisor.send({ type: 'dispatch' })
      const [started] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(started).toMatchObject({ type: 'started' })
      const [termination] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(termination).toMatchObject({ type: 'termination_started', reason: 'timeout' })

      // Intentionally keep IPC connected without replying with termination_ack.
      await exited
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
    }
  }, 5_000)

  it.runIf(process.platform !== 'win32')('kills stubborn descendants when parent IPC disconnects after their command exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-supervisor-descendant-'))
    const marker = join(root, 'orphaned-descendant.txt')
    const supervisor = spawn(process.execPath, ['-e', shellSupervisorProgram], {
      windowsHide: true,
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })
    try {
      const [ready] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(ready).toMatchObject({ type: 'ready' })
      supervisor.send({
        type: 'start',
        executable: process.execPath,
        args: ['-e', [
          `const { spawn } = require('node:child_process')`,
          `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify([
            `process.on('SIGTERM', () => {})`,
            `process.stdout.write('ready')`,
            `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'orphaned'), 2500)`
          ].join(';'))}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })`,
          `descendant.stdout.once('data', () => process.stdout.write('descendant-ready'))`,
          `setTimeout(() => {}, 10_000)`
        ].join(';')],
        cwd: root,
        windowsHide: true,
        environment: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeoutMs: 10_000
      })
      const [dispatching] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(dispatching).toMatchObject({ type: 'dispatching' })
      supervisor.send({ type: 'dispatch' })
      const [started] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(started).toMatchObject({ type: 'started' })
      const [output] = await once(supervisor, 'message') as [Record<string, unknown>]
      expect(output).toMatchObject({
        type: 'output',
        stream: 'stdout',
        text: 'descendant-ready'
      })

      const exited = once(supervisor, 'exit')
      supervisor.disconnect()
      await exited
      await new Promise((resolve) => setTimeout(resolve, 2_700))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})

describe('command shell resolution', () => {
  it('prefers PowerShell 7 on Windows and builds a non-interactive invocation', async () => {
    const probeVersion = vi.fn(async (executable: string) => (
      executable === 'pwsh.exe' ? '7.6.4' : undefined
    ))

    const shell = await resolveCommandShell({
      platform: 'win32',
      probeVersion
    })

    expect(shell).toEqual({
      executable: 'pwsh.exe',
      name: 'PowerShell',
      version: '7.6.4',
      family: 'powershell'
    })
    expect(describeCommandShell(shell)).toBe('PowerShell 7.6.4 (pwsh.exe)')
    expect(commandShellToolName(shell.executable)).toBe('pwsh')
    expect(describeCommandShellTool(shell)).toContain('PowerShell 7.6.4 command with pwsh')
    expect(describeCommandShellArgument(shell)).toContain('PowerShell 7+ syntax')
    expect(await resolveShellInvocation('Get-ChildItem', shell)).toEqual({
      executable: 'pwsh.exe',
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\nGet-ChildItem'
      ],
      windowsHide: true
    })
    expect(probeVersion).toHaveBeenCalledTimes(1)
  })

  it('falls back to Windows PowerShell only when pwsh is unavailable', async () => {
    const probeVersion = vi.fn(async (executable: string) => (
      executable === 'powershell.exe' ? '5.1.26100.9168' : undefined
    ))

    const shell = await resolveCommandShell({
      platform: 'win32',
      probeVersion
    })

    expect(shell).toMatchObject({
      executable: 'powershell.exe',
      name: 'Windows PowerShell',
      version: '5.1.26100.9168',
      family: 'powershell'
    })
    expect(describeCommandShell(shell))
      .toBe('Windows PowerShell 5.1.26100.9168 (powershell.exe)')
    expect(commandShellToolName(shell.executable)).toBe('powershell')
    expect(describeCommandShellTool(shell)).toContain('Windows PowerShell 5.1.26100.9168')
    expect(describeCommandShellArgument(shell)).toContain('Windows PowerShell syntax')
    expect(probeVersion.mock.calls.map(([executable]) => executable))
      .toEqual(['pwsh.exe', 'powershell.exe'])
  })

  it('uses the configured POSIX shell without PowerShell probing', async () => {
    const probeVersion = vi.fn()
    const shell = await resolveCommandShell({
      platform: 'linux',
      environment: { SHELL: '/usr/bin/fish' },
      probeVersion
    })

    expect(shell).toEqual({
      executable: '/usr/bin/fish',
      name: 'fish',
      family: 'posix'
    })
    expect(await resolveShellInvocation('pwd', shell)).toEqual({
      executable: '/usr/bin/fish',
      args: ['-lc', 'pwd'],
      windowsHide: false
    })
    expect(probeVersion).not.toHaveBeenCalled()
  })

  it('defaults to zsh on macOS and names the tool after the executable', async () => {
    const shell = await resolveCommandShell({
      platform: 'darwin',
      environment: {}
    })

    expect(shell).toEqual({
      executable: '/bin/zsh',
      name: 'zsh',
      family: 'posix'
    })
    expect(commandShellToolName(shell.executable)).toBe('zsh')
    expect(describeCommandShellTool(shell)).toContain('Z shell command with /bin/zsh')
    expect(describeCommandShellArgument(shell)).toContain('zsh -lc')
  })

  it('uses a recognizable namespaced tool name for an uncommon shell', () => {
    expect(commandShellToolName('/opt/custom/xonsh')).toBe('shell_xonsh')
    expect(commandShellToolName(`/opt/custom/${'x'.repeat(100)}`)).toHaveLength(64)
  })
})

describe.skipIf(process.platform !== 'win32')('PowerShell output encoding', () => {
  const shell = { executable: 'pwsh.exe', name: 'PowerShell', family: 'powershell' } as const
  const invoke = (command: string, workingDir = process.cwd(), callbacks: ShellRunCallbacks = {}) => runShellCommand({
    command, workingDir, timeoutSec: 15, keepProcesses: false
  }, shell, undefined, callbacks)

  it('sends Chinese stdout and stderr through the supervisor as UTF-8', async () => {
    const expected = '中文测试：百度搜索 🥝'
    const stdout: string[] = []
    const stderr: string[] = []
    const result = JSON.parse(await invoke([
      '[Console]::OutputEncoding.CodePage',
      `[Console]::Out.Write('${expected}')`,
      `[Console]::Error.Write('${expected}')`
    ].join('\n'), process.cwd(), {
      onOutput: (stream: 'stdout' | 'stderr', text: string) => (
        stream === 'stdout' ? stdout : stderr
      ).push(text)
    })) as ShellRunResult

    expect(result).toMatchObject({ ok: true, exitCode: 0, stderr: expected })
    expect(result.stdout.replaceAll('\r\n', '\n')).toBe(`65001\n${expected}`)
    expect(stdout.join('')).toBe(result.stdout)
    expect(stderr.join('')).toBe(expected)
  })

  it('reads UTF-8 files by default and GBK files with explicit decoding without modifying either', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-encoding-'))
    const utf8Path = join(root, 'utf8.txt')
    const gbkPath = join(root, 'gbk.txt')
    const utf8 = Buffer.from('中文测试 🥝', 'utf8')
    const gbk = Buffer.from('d6d0cec4b2e2cad4', 'hex')
    try {
      await writeFile(utf8Path, utf8)
      await writeFile(gbkPath, gbk)
      const result = await invoke([
        "Get-Content -LiteralPath './utf8.txt' -Raw",
        "Get-Content -LiteralPath './gbk.txt' -Raw -Encoding 936"
      ].join('\n'), root)

      expect(result.replaceAll('\r\n', '\n')).toBe('中文测试 🥝\n中文测试\n')
      expect(await readFile(utf8Path)).toEqual(utf8)
      expect(await readFile(gbkPath)).toEqual(gbk)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps multiline strings, quotes, comments, and explicit parameterized script blocks intact', async () => {
    const command = [
      '& { param([string]$text = "中文测试")',
      "$message = @'",
      "单引号 ' 双引号 \" 与 $变量保持原样",
      "'@",
      '$text',
      '$message',
      '} # trailing comment'
    ].join('\n')
    const result = await invoke(command)
    expect(result.replaceAll('\r\n', '\n'))
      .toBe('中文测试\n单引号 \' 双引号 " 与 $变量保持原样\n')
  })

  it.each([false, true])('streams delayed UTF-8 output with keepProcesses=%s', async (keepProcesses) => {
    const streamed: string[] = []
    const result = await runShellCommand({
      command: [
        "[Console]::Out.Write('开始读取')",
        'Start-Sleep -Milliseconds 300',
        "[Console]::Out.Write('读取完成')"
      ].join('\n'),
      workingDir: process.cwd(), timeoutSec: 15, keepProcesses
    }, shell, undefined, {
      onOutput: (_stream, text) => streamed.push(text)
    })
    expect(streamed.join('')).toBe('开始读取读取完成')
    expect(result).toBe('开始读取读取完成')
  })

  it.each([
    ["param([string]$text = '中文测试 🥝')\n$text", '中文测试 🥝\n'],
    ["using namespace System.Text\nparam([string]$text = '中文测试')\n[Encoding]::UTF8.WebName\n$text", 'utf-8\n中文测试\n'],
    ["begin <# { is only a comment #> { '中文测试' } process { '处理' } end { '结束' }", '中文测试\n处理\n结束\n'],
    ["param([string]$text = '中文测试')\nprocess { $text }", '中文测试\n'],
    ["end { '中文测试' }", '中文测试\n']
  ])('preserves top-level declarations: %s', async (command, expected) => {
    const result = await invoke(command)
    expect(result.replaceAll('\r\n', '\n')).toBe(expected)
  })

  it('only parses module declarations during preparation and runs the module once during execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-shell-module-'))
    const marker = join(root, 'loaded.txt')
    const modulePath = join(root, 'probe.psm1')
    const command = `using module '${modulePath.replaceAll("'", "''")}'\n'中文测试'`
    try {
      await writeFile(modulePath, `[System.IO.File]::AppendAllText('${marker.replaceAll("'", "''")}', 'loaded')`, 'utf8')
      await resolveShellInvocation(command, shell)
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await invoke(command)).trim()).toBe('中文测试')
      expect(await readFile(marker, 'utf8')).toBe('loaded')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps cancellation before declaration parsing from starting the command', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = JSON.parse(await runShellCommand({
      command: "param()\n'Not executed'", workingDir: process.cwd(), timeoutSec: 15, keepProcesses: false
    }, shell, controller.signal)) as ShellRunResult
    expect(result).toMatchObject({ ok: false, aborted: true, stdout: '', stderr: '' })
  })

  it.each([
    ['native failure', 'cmd.exe /d /c exit 7', 1],
    ['failure followed by return', 'cmd.exe /d /c exit 7; return', 1],
    ['declarations followed by failure and return', 'param()\ncmd.exe /d /c exit 7; return', 1],
    ['explicit exit', 'exit 7', 7],
    ['non-terminating error', "Write-Error '中文错误'", 1],
    ['terminating error', "throw '中文错误'", 1]
  ])('preserves failure status for %s', async (_name, command, exitCode) => {
    const result = JSON.parse(await invoke(command)) as ShellRunResult
    expect(result).toMatchObject({ ok: false, exitCode })
    expect(result.stderr).not.toContain('\uFFFD')
    if (command.includes('中文错误')) expect(result.stderr).toContain('中文错误')
  })

  it('also initializes UTF-8 for the existing Windows PowerShell runtime', async () => {
    const result = await runShellCommand({
      command: "param([string]$text = '中文测试')\n[Console]::Out.Write($text)",
      workingDir: process.cwd(), timeoutSec: 15, keepProcesses: false
    }, { ...shell, executable: 'powershell.exe', name: 'Windows PowerShell' })
    expect(result).toBe('中文测试')
  })
})
