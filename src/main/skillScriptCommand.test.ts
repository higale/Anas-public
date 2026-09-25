import { describe, expect, it } from 'vitest'
import { scriptOperand } from './skillScriptCommand'

describe('literal interpreter file invocation', () => {
  it.each([
    ['python', ['scripts/query.py', '--month', '2026-09']],
    ['python3.13', ['-u', '-B', 'scripts/query.py', '--text', 'a; b && c']],
    ['py.exe', ['-3.13', 'scripts/query.py']],
    ['node', ['--', 'scripts/query.py', '--eval', 'a script argument']],
    ['ruby', ['scripts/query.py']], ['perl', ['scripts/query.py']], ['lua', ['scripts/query.py']],
    ['bash', ['-eu', 'scripts/query.py']], ['sh', ['scripts/query.py']], ['zsh', ['scripts/query.py']],
    ['pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', 'scripts/query.py', '-Month', '2026-09']],
    ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'scripts/query.py']]
  ] as Array<[string, string[]]>)('identifies only the file operand of %s %j', (program, args) => {
    expect(scriptOperand(program, args)).toBe('scripts/query.py')
  })

  it.each([
    ['python', ['-c', 'print(1)', 'script.py']], ['python', ['-m', 'module', 'script.py']],
    ['python', ['-i', 'script.py']], ['python', ['-']], ['python', []],
    ['node', ['-e', 'code', 'script.js']], ['node', ['--require', 'other.js', 'script.js']],
    ['node', ['--import=other.js', 'script.js']], ['bun', ['run', 'script.ts']],
    ['bash', ['-c', 'commands', 'script.sh']], ['pwsh', ['-Command', 'script.ps1']],
    ['pwsh', ['script.ps1']], ['cmd.exe', ['/c', 'script.cmd']],
    ['uv', ['run', 'python', 'script.py']], ['python.cmd', ['script.py']],
    ['npm', ['run', 'script.js']], ['unknown', ['script.py']]
  ] as Array<[string, string[]]>)('keeps unrecognized execution under approval: %s %j', (program, args) => {
    expect(scriptOperand(program, args)).toBeUndefined()
  })
})
