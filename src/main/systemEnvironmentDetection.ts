import type { DetectedSystemEnvironmentTool, SystemEnvironmentDetection } from '@shared/types'
import { discoverPython3, runRuntimeProbe, type RuntimeProbeOptions, type RuntimeProbeRunner } from './runtimeDiscovery'

const probeConcurrency = 4
const maximumProbeOutputLineLength = 240

interface ProbeCommand {
  executable: string
  args: string[]
  displayExecutable?: string
}

type ToolProbe = { commands: ProbeCommand[] } | { python: true }

export interface DetectSystemEnvironmentOptions extends RuntimeProbeOptions {
  platform?: NodeJS.Platform
  runProbe?: RuntimeProbeRunner
}

function command(executable: string, ...args: string[]): ProbeCommand {
  return { executable, args }
}

function windowsCommand(executable: string, ...args: string[]): ProbeCommand {
  return { executable: `${executable}.exe`, args, displayExecutable: executable }
}

function windowsScriptCommand(executable: string, ...args: string[]): ProbeCommand {
  const script = [executable, ...args].join(' ')
  return {
    executable: 'cmd.exe',
    args: ['/d', '/s', '/c', script],
    displayExecutable: executable
  }
}

function commonToolProbes(platform: NodeJS.Platform): ToolProbe[] {
  const windows = platform === 'win32'
  const direct = windows ? windowsCommand : command
  const script = windows ? windowsScriptCommand : command
  return [
    { python: true },
    { commands: [direct('uv', '--version')] },
    { commands: [script('conda', '--version')] },
    { commands: [direct('node', '--version')] },
    { commands: [script('npm', '--version')] },
    { commands: [script('pnpm', '--version')] },
    { commands: [script('yarn', '--version')] },
    { commands: [direct('bun', '--version')] },
    { commands: [direct('deno', '--version')] },
    { commands: [direct('java', '-version')] },
    { commands: [direct('go', 'version')] },
    { commands: [direct('jq', '--version')] }
  ]
}

function windowsToolProbes(): ToolProbe[] {
  return [
    { commands: [windowsCommand('git', '--version')] },
    { commands: [windowsCommand('svn', '--version', '--quiet')] },
    { commands: [windowsCommand('cmake', '--version')] }
  ]
}

function firstOutputLine(output: string): string | undefined {
  const line = output
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean)
  return line?.replace(/\s+/g, ' ').slice(0, maximumProbeOutputLineLength)
}

function versionFromOutput(output: string): string | undefined {
  return /(?:^|[^\d])v?(\d+(?:\.\d+)+)/i.exec(output)?.[1]
}

async function detectTool(
  probe: ToolProbe,
  options: DetectSystemEnvironmentOptions
): Promise<DetectedSystemEnvironmentTool | undefined> {
  if ('python' in probe) {
    const runtime = await discoverPython3(options)
    return runtime && { command: runtime.command, version: runtime.version }
  }
  const runProbe = options.runProbe ?? runRuntimeProbe
  for (const candidate of probe.commands) {
    options.signal?.throwIfAborted()
    const output = await runProbe(candidate.executable, candidate.args, options)
    const line = output && firstOutputLine(output)
    const version = line ? versionFromOutput(line) : undefined
    if (!version) continue
    return {
      command: candidate.displayExecutable ?? candidate.executable,
      version
    }
  }
  return undefined
}

async function detectTools(
  probes: ToolProbe[],
  options: DetectSystemEnvironmentOptions
): Promise<DetectedSystemEnvironmentTool[]> {
  const results = new Array<DetectedSystemEnvironmentTool | undefined>(probes.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.min(probeConcurrency, probes.length) }, async () => {
    while (nextIndex < probes.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await detectTool(probes[index], options)
    }
  })
  await Promise.all(workers)
  return results.filter((item): item is DetectedSystemEnvironmentTool => item !== undefined)
}

export function formatSystemEnvironmentDetection(tools: DetectedSystemEnvironmentTool[]): string {
  if (tools.length === 0) return ''
  return [
    'Available common commands:',
    ...tools.map((tool) => `- ${tool.command}: ${tool.version}`)
  ].join('\n')
}

export async function detectSystemEnvironment(
  options: DetectSystemEnvironmentOptions = {}
): Promise<SystemEnvironmentDetection> {
  const platform = options.platform ?? process.platform
  const probes = [
    ...commonToolProbes(platform),
    ...(platform === 'win32' ? windowsToolProbes() : [])
  ]
  const tools = await detectTools(probes, options)
  return {
    content: formatSystemEnvironmentDetection(tools),
    tools
  }
}
