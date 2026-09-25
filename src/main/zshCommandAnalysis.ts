import { realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { parse } from 'shell-quote'
import { resolveCanonicalWorkspacePath, resolveShellOperandPath } from './workspacePath'
import type { ShellCommandAuthorizationOptions, ShellCommandPlan } from './shellCommandAuthorization'
import { runShellCommand } from './shellRuntime'
import { runWithoutCurrentAgentToolEffect } from './agent/toolEffectScope'
import { withoutToolExecution } from './agent/toolExecutionContext'
import { findSkillScriptExemption, type SkillScriptInvocation } from './skillsStore'
import { scriptOperand } from './skillScriptCommand'

const bindingError = 'Shell bindings changed. Resubmit for manual authorization.'
const programs: Record<string, string> = { cat: '/bin/cat', head: '/usr/bin/head', tail: '/usr/bin/tail', wc: '/usr/bin/wc' }

function unknown(): never { throw new Error('Shell semantics require manual authorization') }

// shell-quote owns quoting/tokenization. This lexical gate restricts its POSIX
// grammar to literal words shared by zsh: notably no unquoted glob qualifiers,
// equals/tilde expansion, substitutions, escapes, comments or control syntax.
function literalPipeline(source: string): string[][] {
  if (!source || source.length > 8192 || /[\0\r\n]/.test(source)) unknown()
  const lexeme = /[ \t]+|[\p{L}\p{N}_./,:+%@-]+|'[^'\0\r\n]*'|"[^"$\\`\0\r\n]*"|\|/uy
  let offset = 0
  while (offset < source.length) {
    lexeme.lastIndex = offset
    const match = lexeme.exec(source)
    if (!match) unknown()
    offset = lexeme.lastIndex
  }
  const commands: string[][] = [[]]
  for (const token of parse(source, () => unknown())) {
    if (typeof token === 'string') commands.at(-1)!.push(token)
    else if ('op' in token && token.op === '|' && commands.at(-1)!.length) commands.push([])
    else unknown()
  }
  if (commands.length > 8 || commands.some((words) => !words.length || words.length > 128)) unknown()
  return commands
}

// A separate, bounded probe inspects login-shell bindings without executing the
// requested command. Never splice these checks into the user's command.
// No builtin/command/exec bootstrap is used: all three can themselves be functions.
function doubleQuote(value: string): string { return `"${value.replace(/[\\"$`]/g, '\\$&')}"` }
function literal(value: string): string { return '${:-' + doubleQuote(value) + '}' }
function check(value: string, expected: string): string {
  return '${${${(M)' + value + ':#' + doubleQuote(expected) + '}:?' + bindingError + '}:+}'
}
function noFunction(name: string): string {
  // Shell associative subscripts have their own grammar. Only fixed program
  // names and installation paths in this explicit alphabet are eligible.
  if (!/^[\p{L}\p{N}_./ +@-]+$/u.test(name)) unknown()
  return check('${+functions[' + name + ']}', '0')
}

async function probeZsh(command: string, workingDir: string, options: ShellCommandAuthorizationOptions): Promise<string> {
  if (Buffer.byteLength(command) > 120000) unknown()
  let output: string | undefined
  await runWithoutCurrentAgentToolEffect(() => withoutToolExecution(() => runShellCommand({
    command, pathPrepend: dirname(options.rgExecutable), workingDir, env: options.env,
    timeoutSec: 2, keepProcesses: false
  }, options.shell, options.signal, { onResult: result => { if (result.ok) output = result.stdout } })))
  if (output === undefined) unknown()
  return output
}

async function resolveZshExecutor(name: string, cwd: string, options: ShellCommandAuthorizationOptions): Promise<string> {
  if (name.includes('/')) return isAbsolute(name) ? name : `${cwd}/${name}`
  if (!/^[a-zA-Z0-9.]+$/.test(name)) unknown()
  // Ask the same login shell for its binding, without invoking the interpreter.
  // The full binding probe below verifies functions, aliases and that result.
  const checks = check('${(t)functions}', 'association-hide-hideval-special')
    + check('${(t)commands}', 'association-hide-hideval-special') + noFunction('/usr/bin/printf')
  const output = await probeZsh('"' + checks + '/usr/bin/printf" \'%s\' "ANAS_EXECUTOR_START${commands[' + name + ']}ANAS_EXECUTOR_END"', cwd, options)
  const executable = output.match(/ANAS_EXECUTOR_START([^\0\r\n]+)ANAS_EXECUTOR_END$/)?.[1]
  if (!executable || !isAbsolute(executable)) unknown()
  return executable
}

export async function analyzeZshCommand(
  command: string, workingDir: string, options: ShellCommandAuthorizationOptions,
  inspectRgArgs: (args: string[], cwd: string, path: (value: string, directoryAllowed?: boolean) => Promise<string>, env: NodeJS.ProcessEnv) => Promise<boolean>,
  invocation?: SkillScriptInvocation
): Promise<ShellCommandPlan | undefined> {
  // Bash has no equivalent inspectable special function table. Do not claim its
  // startup/function semantics are proved by a POSIX tokenizer or another shell.
  if (process.platform !== 'darwin' || options.shell.family !== 'posix' || options.shell.executable !== '/bin/zsh') return undefined
  if (command.length > 16384) unknown()
  const parsed = literalPipeline(command)
  const cwd = await resolveCanonicalWorkspacePath(workingDir, options.primaryFolder, 'follow')
  if (!(await stat(cwd.canonicalPath)).isDirectory()) unknown()
  const paths = new Set([cwd.canonicalPath])
  const path = async (value: string, directoryAllowed = false) => {
    if (!value || value === '-' || /[\0\r\n]/.test(value)) unknown()
    const target = await resolveShellOperandPath(value, cwd.canonicalPath)
    const info = await stat(target)
    if (!info.isFile() && !(directoryAllowed && info.isDirectory())) unknown()
    paths.add(target)
    if (paths.size > 64) unknown()
    return target
  }
  const bindings: Array<{ name: string; executable: string }> = []
  let usesRgConfig = false
  let skillScript: ShellCommandPlan['skillScript']
  const operand = parsed.length === 1 ? scriptOperand(parsed[0][0], parsed[0].slice(1)) : undefined
  if (operand && options.skills) {
    const name = parsed[0][0]
    const executable = await resolveZshExecutor(name, cwd.canonicalPath, options)
    if (!scriptOperand(executable, parsed[0].slice(1)) || !(await stat(executable)).isFile()) unknown()
    const script = await path(operand)
    // Some interpreters (notably Node) normalize their entry path before
    // opening it. Both interpretations must name the same file for exemption.
    if (script !== await realpath(resolve(cwd.canonicalPath, operand))) unknown()
    const exemption = await findSkillScriptExemption(script, options.skills, invocation)
    if (!exemption) unknown()
    const executor = await realpath(executable)
    paths.add(executor)
    skillScript = { ...exemption, executor }
    bindings.push({ name, executable })
  } else for (const [index, [name, ...args]] of parsed.entries()) {
    const rg = name === 'rg' || name === options.rgExecutable
    const executable = rg ? options.rgExecutable : programs[name] ?? Object.values(programs).find((file) => file === name)
    if (!executable || !isAbsolute(executable)) unknown()
    bindings.push({ name, executable })
    if (rg) {
      // A pipe consumer with implicit stdin has different target semantics.
      if (index !== 0) unknown()
      usesRgConfig = await inspectRgArgs(args, cwd.canonicalPath, path, options.env) || usesRgConfig
      continue
    }
    const kind = Object.keys(programs).find((key) => programs[key] === executable)!
    const targets: string[] = []
    let operands = false
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]
      if (!operands && arg === '--') { operands = true; continue }
      if (!operands && arg.startsWith('-')) {
        if (kind === 'cat' && /^-[benstuv]+$/.test(arg)
          || kind === 'wc' && /^-[clmw]+$/.test(arg)) continue
        if ((kind === 'head' || kind === 'tail') && (arg === '-n' || arg === '-c') && /^\d{1,8}$/.test(args[i + 1] ?? '')) {
          i++; continue
        }
        unknown()
      }
      operands = true
      targets.push(await path(arg))
    }
    if ((!targets.length && index === 0) || (targets.length && index !== 0)) unknown()
  }
  const checks = [
    ...['functions', 'aliases', 'galiases', 'saliases', 'options', 'commands'].map((name) =>
      check('${(t)' + name + '}', 'association-hide-hideval-special')),
    check('${#galiases}', '0'), check('${#saliases}', '0'),
    check('${options[rcquotes]}', 'off'), check('${options[cshjunkiequotes]}', 'off'),
    check('${options[debugbeforecmd]}', 'on'),
    ...(usesRgConfig ? [check('${#${RIPGREP_CONFIG_PATH-}}', '0')] : []),
    check('${PWD:A}', cwd.canonicalPath),
    ...[...paths].map((value) => check('${' + literal(value) + ':A}', value)),
    ...bindings.flatMap(({ name, executable }) => [
      noFunction(name), noFunction(executable),
      check('${+aliases[' + name + ']}', '0'),
      ...(name.includes('/') ? [] : [check('${commands[' + name + ']}', executable)])
    ])
  ].join('')
  const guarded = (executable: string) => '"' + checks + noFunction(executable) + executable.replace(/[\\"$`]/g, '\\$&') + '"'
  const probe = guarded('/usr/bin/printf') + " '%s' ANAS_READ_BINDING_OK"
  // This is an application preflight, not the pending tool's external effect.
  // In particular, a failed probe must leave recovery free to retry that tool.
  if (!(await probeZsh(probe, cwd.canonicalPath, options)).endsWith('ANAS_READ_BINDING_OK')) unknown()
  return {
    workingDir: cwd.canonicalPath, executable: options.shell.executable, paths: [...paths], ...(skillScript ? { skillScript } : {})
  }
}
