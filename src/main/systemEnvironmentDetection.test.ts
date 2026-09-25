import { describe, expect, it, vi } from 'vitest'
import { detectSystemEnvironment, formatSystemEnvironmentDetection } from './systemEnvironmentDetection'

describe('system environment detection', () => {
  it('detects common commands and falls back between Python executables', async () => {
    const outputs = new Map([
      ['python', '3.13.7\n/usr/bin/python'],
      ['uv --version', 'uv 0.8.12 (abc123 2026-01-02 x86_64-pc-windows-msvc)'],
      ['node --version', 'v24.14.0'],
      ['rg --version', 'ripgrep 15.2.0 (rev e89fff89ac)'],
      ['jq --version', 'jq-1.8.1']
    ])
    const runProbe = vi.fn(async (executable: string, args: string[]) => (
      outputs.get(args.includes('-c') ? executable : [executable, ...args].join(' '))
    ))

    const result = await detectSystemEnvironment({ platform: 'linux', runProbe })

    expect(result.tools).toEqual([
      { command: 'python', version: '3.13.7' },
      { command: 'uv', version: '0.8.12' },
      { command: 'node', version: '24.14.0' },
      { command: 'jq', version: '1.8.1' }
    ])
    expect(result.content).toBe([
      'Available common commands:',
      '- python: 3.13.7',
      '- uv: 0.8.12',
      '- node: 24.14.0',
      '- jq: 1.8.1'
    ].join('\n'))
    expect(runProbe).not.toHaveBeenCalledWith('git', ['--version'])
    expect(runProbe).not.toHaveBeenCalledWith('rg', ['--version'])
  })

  it('adds Windows-specific Git, Subversion, and CMake probes', async () => {
    const outputs = new Map([
      ['python.exe', '3.12.10\nC:\\Python\\python.exe'],
      ['node.exe --version', 'v22.18.0'],
      ['git.exe --version', 'git version 2.50.1.windows.1'],
      ['svn.exe --version --quiet', '1.14.5'],
      ['cmake.exe --version', 'cmake version 4.1.0'],
      ['rg.exe --version', 'ripgrep 15.2.0'],
      ['jq.exe --version', 'jq-1.8.1']
    ])
    const runProbe = vi.fn(async (executable: string, args: string[]) => (
      outputs.get(args.includes('-c') ? executable : [executable, ...args].join(' '))
    ))

    const result = await detectSystemEnvironment({ platform: 'win32', runProbe })

    expect(result.tools).toEqual([
      { command: 'python', version: '3.12.10' },
      { command: 'node', version: '22.18.0' },
      { command: 'jq', version: '1.8.1' },
      { command: 'git', version: '2.50.1' },
      { command: 'svn', version: '1.14.5' },
      { command: 'cmake', version: '4.1.0' }
    ])
    expect(result.content).toContain('- git: 2.50.1')
    expect(result.content).toContain('- svn: 1.14.5')
    expect(result.content).not.toContain('rg:')
    expect(runProbe).not.toHaveBeenCalledWith('rg.exe', ['--version'])
    expect(result.content).toContain('- jq: 1.8.1')
    expect(runProbe).not.toHaveBeenCalledWith('dotnet.exe', ['--version'])
    expect(runProbe).not.toHaveBeenCalledWith('winget.exe', ['--version'])
  })

  it('returns empty content when no supported tool is available', async () => {
    const result = await detectSystemEnvironment({
      platform: 'darwin',
      runProbe: async () => undefined
    })

    expect(result).toEqual({ content: '', tools: [] })
    expect(formatSystemEnvironmentDetection([])).toBe('')
  })

  it('keeps the launcher version selector in the environment description', async () => {
    const result = await detectSystemEnvironment({ platform: 'win32', runProbe: async executable =>
      executable === 'py.exe' ? '3.13.3\nC:\\Python3\\python.exe' : undefined })
    expect(result.tools).toEqual([{ command: 'py -3', version: '3.13.3' }])
    expect(result.content).toContain('- py -3: 3.13.3')
  })
})
