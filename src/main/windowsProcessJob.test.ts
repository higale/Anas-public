import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createWindowsKillOnCloseJob, type WindowsProcessJob } from './windowsProcessJob'

const jobs = new Set<WindowsProcessJob>()

afterEach(() => {
  for (const job of jobs) {
    try {
      job.close()
    } catch {
      // The test still performs its filesystem assertion when cleanup already happened.
    }
  }
  jobs.clear()
})

describe.runIf(process.platform === 'win32')('WindowsProcessJob', () => {
  it('kills an assigned process and its descendants when the job closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-windows-job-'))
    const marker = join(root, 'descendant-survived.txt')
    const supervisor = spawn(process.execPath, ['-e', [
      `const { spawn } = require('node:child_process')`,
      `process.once('message', () => {`,
      `  const descendant = spawn(process.execPath, ['-e', ${JSON.stringify([
        `process.stdout.write('ready')`,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 1200)`
      ].join(';'))}], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] })`,
      `  descendant.stdout.once('data', () => { if (process.send) process.send({ type: 'descendant_started' }) })`,
      `})`,
      `setTimeout(() => {}, 10_000)`
    ].join(';')], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })

    try {
      expect(supervisor.pid).toBeTypeOf('number')
      const job = createWindowsKillOnCloseJob()
      jobs.add(job)
      job.addProcess(supervisor.pid!)

      await new Promise<void>((resolve, reject) => {
        supervisor.once('error', reject)
        supervisor.once('message', (message) => {
          expect(message).toMatchObject({ type: 'descendant_started' })
          resolve()
        })
        supervisor.send({ type: 'start' })
      })

      const exited = once(supervisor, 'exit')
      job.close()
      jobs.delete(job)
      await exited
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('lets assigned descendants continue after the job is explicitly released', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-windows-job-release-'))
    const marker = join(root, 'descendant-survived.txt')
    const descendantScript = Buffer.from(
      `Start-Sleep -Milliseconds 1200; [IO.File]::WriteAllText(${JSON.stringify(marker)}, 'survived')`,
      'utf16le'
    ).toString('base64')
    const supervisorScript = Buffer.from(
      `Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-EncodedCommand','${descendantScript}'); Write-Output ready; Start-Sleep -Seconds 10`,
      'utf16le'
    ).toString('base64')
    const supervisor = spawn('powershell.exe', [
      '-NoProfile',
      '-EncodedCommand',
      supervisorScript
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })

    try {
      expect(supervisor.pid).toBeTypeOf('number')
      const job = createWindowsKillOnCloseJob()
      jobs.add(job)
      job.addProcess(supervisor.pid!)

      await once(supervisor.stdout!, 'data')

      job.release()
      jobs.delete(job)
      supervisor.kill('SIGKILL')
      await once(supervisor, 'exit')
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      await expect(access(marker)).resolves.toBeUndefined()
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  }, 10_000)
})
