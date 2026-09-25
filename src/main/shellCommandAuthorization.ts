import { parseArgs } from 'node:util'
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AgentAccessMode } from '@shared/agentTypes'
import { isSameOrInsideDirectory, samePath } from './pathContainment'
import { resolveCanonicalWorkspacePath } from './workspacePath'
import type { CommandShellInfo } from './shellRuntime'
import { parsePowerShellCommands, type PowerShellWord } from './powershellCommandAnalysis'
import { analyzeZshCommand } from './zshCommandAnalysis'
import { findSkillScriptExemption, type SkillScriptInvocation, type SkillScriptScope } from './skillsStore'
import { scriptOperand } from './skillScriptCommand'

export interface ShellCommandPlan {
  workingDir: string
  executable: string
  paths: string[]
  skillScript?: { skillId: string; root: string; script: string; executor: string }
}

// This is an auto-approval vocabulary, NOT a restriction on Shell execution.
// Unknown options/commands are left intact for the existing human approval path.
const rgOptions: Record<string, { type: 'boolean' | 'string'; short?: string }> = {}
for (const entry of 'regexp:e file:f glob:g iglob type:t type-not:T encoding:E engine max-count:m max-columns:M max-depth:d max-filesize threads:j after-context:A before-context:B context:C ignore-file sort sortr regex-size-limit dfa-size-limit color'.split(' ')) {
  const [name, short] = entry.split(':')
  rgOptions[name] = { type: 'string', ...(short ? { short } : {}) }
}
for (const entry of 'files type-list help:h version:V fixed-strings:F ignore-case:i case-sensitive:s smart-case:S word-regexp:w line-regexp:x invert-match:v only-matching:o quiet:q line-number:n no-line-number:N with-filename:H no-filename:I files-with-matches:l files-without-match count:c count-matches null:0 hidden no-hidden no-ignore no-ignore-dot no-ignore-exclude no-ignore-files no-ignore-global no-ignore-parent no-ignore-vcs no-require-git no-config no-follow no-mmap crlf multiline:U multiline-dotall pcre2:P no-pcre2 text:a json stats debug'.split(' ')) {
  const [name, short] = entry.split(':')
  rgOptions[name] = { type: 'boolean', ...(short ? { short } : {}) }
}

async function inspectRgArgs(
  args: string[], cwd: string, path: (value: string, directoryAllowed?: boolean) => Promise<string>, env: NodeJS.ProcessEnv
): Promise<boolean> {
  const parsed = parseArgs({ args, options: rgOptions, strict: true, allowPositionals: true, tokens: true })
  // Config can enable preprocessors or link traversal. Do not silently disable
  // it to obtain approval; unknown implicit arguments require human review.
  const configKey = Object.keys(env).sort().find((key) => process.platform === 'win32'
    ? key.toUpperCase() === 'RIPGREP_CONFIG_PATH' : key === 'RIPGREP_CONFIG_PATH')
  if (!parsed.values['no-config'] && configKey && env[configKey]) unknown()
  const explicitPattern = parsed.tokens.some((token) => token.kind === 'option' && (token.name === 'regexp' || token.name === 'file'))
  const informational = Boolean(parsed.values.help || parsed.values.version || parsed.values['type-list'])
  let needsPattern = !explicitPattern && !parsed.values.files && !informational
  let targets = 0
  for (const token of parsed.tokens) {
    if (token.kind === 'option') {
      if (token.value !== undefined) {
        if ((token.name === 'file' || token.name === 'ignore-file') && token.value === '-') unknown()
        if (token.name === 'file' || token.name === 'ignore-file') await path(token.value, false)
      }
    } else if (token.kind === 'positional') {
      if (needsPattern) needsPattern = false
      else { if (token.value === '-') unknown(); await path(token.value, true); targets++ }
    }
  }
  if (needsPattern) unknown()
  if (!targets && !informational) await path(cwd, true)
  return !parsed.values['no-config']
}

function unknown(): never { throw new Error('Command requires manual authorization') }
function literalPath(value: string): string {
  // Providers, wildcards, devices, ADS and ambiguous Windows path forms are not
  // treated as ordinary filesystem paths by this small deterministic analyzer.
  if (!value || value !== value.trim() || /[\0\r\n*?[\]]/.test(value)
    || /[<>|]/.test(value) || value.slice(/^[a-z]:[\\/]/i.test(value) ? 2 : 0).includes(':')) unknown()
  return value
}

export interface ShellCommandAuthorizationOptions {
  shell: CommandShellInfo
  env: NodeJS.ProcessEnv
  rgExecutable: string
  primaryFolder: string
  trustedFolders: string[]
  accessMode(): AgentAccessMode
  signal?: AbortSignal
  skills?: SkillScriptScope
}

export function createShellCommandAuthorization(options: ShellCommandAuthorizationOptions) {
  async function analyze(command: string, workingDir: string, invocation?: SkillScriptInvocation): Promise<ShellCommandPlan | undefined> {
    if (process.platform === 'darwin') return analyzeZshCommand(command, workingDir, options, inspectRgArgs, invocation)
    if (process.platform !== 'win32' || options.shell.family !== 'powershell') return undefined
    const cwd = await resolveCanonicalWorkspacePath(literalPath(workingDir), options.primaryFolder, 'follow')
    if (!(await stat(cwd.canonicalPath)).isDirectory()) return undefined
    const script = await parsePowerShellCommands(command, options.shell.executable, options.env, options.signal, cwd.canonicalPath)
    if (!script || !isAbsolute(script.executable)) return undefined
    const paths = new Set([cwd.canonicalPath])
    const path = async (value: string, directoryAllowed = true) => {
      const target = await resolveCanonicalWorkspacePath(literalPath(value), cwd.canonicalPath, 'follow')
      const info = await stat(target.canonicalPath)
      if (!info.isFile() && !(directoryAllowed && info.isDirectory())) unknown()
      paths.add(target.canonicalPath)
      if (paths.size > 64) unknown()
      return target.canonicalPath
    }
    // A Skill exemption applies to exactly one literal invocation, never one
    // command extracted from a larger pipeline or sequence.
    if (options.skills && script.pipelines.length === 1 && script.pipelines[0].commands.length === 1) {
      const item = script.pipelines[0].commands[0]
      const args = item.words.slice(1).map(word => word.text)
      if (item.commandType === 'Application' && isAbsolute(item.source)
        && args.every(value => value && !/["\r\n\0]/.test(value) && !/\s.*\\$/.test(value))) {
        const operand = scriptOperand(item.source, args)
        if (operand) {
          const target = await path(operand, false)
          const exemption = await findSkillScriptExemption(target, options.skills, invocation)
          if (exemption) return { workingDir: cwd.canonicalPath, executable: script.executable, paths: [...paths],
            skillScript: { ...exemption, executor: await realpath(item.source) } }
        }
      }
    }
    const rg = async (words: PowerShellWord[]) => {
      const args = words.map(({ text }) => text)
      // Avoid PowerShell/native argument-marshalling differences across 5.1/7.x.
      // These forms remain usable after manual approval, with original syntax.
      if (args.some((value) => !value || /["\r\n\0]/.test(value) || /\s.*\\$/.test(value))) unknown()
      await inspectRgArgs(args, cwd.canonicalPath, path, options.env)
    }
    const readNames: Record<string, string> = {
      'get-content': 'Get-Content', gc: 'Get-Content', cat: 'Get-Content', type: 'Get-Content',
      'get-item': 'Get-Item', gi: 'Get-Item', 'get-childitem': 'Get-ChildItem', gci: 'Get-ChildItem', ls: 'Get-ChildItem', dir: 'Get-ChildItem',
      'test-path': 'Test-Path'
    }
    const consumerNames: Record<string, string> = {
      'select-object': 'Select-Object', select: 'Select-Object', 'measure-object': 'Measure-Object', measure: 'Measure-Object',
      'select-string': 'Select-String', sls: 'Select-String', 'sort-object': 'Sort-Object', sort: 'Sort-Object'
    }
    for (const pipeline of script.pipelines) {
      let textPipeline = false
      for (const [index, item] of pipeline.commands.entries()) {
        const [first, ...words] = item.words
        const name = first.text.toLowerCase().replace(/^microsoft\.powershell\.(management|utility)\\/, '')
        if (index === 0 && (['rg', 'rg.exe'].includes(first.text.toLowerCase()) || samePath(first.text, options.rgExecutable))) {
          if (item.commandType !== 'Application' || !samePath(item.source, options.rgExecutable)) unknown()
          await rg(words); textPipeline = true; continue
        }
        const readName = index === 0 && Object.hasOwn(readNames, name) ? readNames[name] : undefined
        const consumer = index > 0 && Object.hasOwn(consumerNames, name) ? consumerNames[name] : undefined
        if (!readName && !consumer) unknown()
        // Select-String reads FileInfo pipeline inputs as files. Directory/item
        // listings can contain links, so only known text streams may reach it.
        if (consumer === 'Select-String' && !textPipeline) unknown()
        if (index === 0) textPipeline = readName === 'Get-Content'
        if (consumer === 'Measure-Object' || consumer === 'Select-String') textPipeline = false
        const module = `Microsoft.PowerShell.${readName ? 'Management' : 'Utility'}`
        if (item.commandType !== 'Cmdlet' || item.source !== module || item.resolvedName !== (readName ?? consumer)) unknown()
        if (first.text.includes('\\') && first.text.toLowerCase() !== `${module}\\${readName ?? consumer}`.toLowerCase()) unknown()
        let suppliedPath = false
        for (let i = 0; i < words.length; i++) {
          const word = words[i]
          const parameter = word.parameter ? word.text.toLowerCase() : undefined
          if (readName && (!parameter || parameter === '-literalpath' || parameter === '-path')) {
            if (suppliedPath) unknown()
            const value = parameter ? words[++i] : word
            if (!value || value.parameter) unknown()
            await path(value.text, readName !== 'Get-Content')
            suppliedPath = true
          } else if (readName === 'Get-Content' && parameter === '-raw') continue
          else if (parameter && ((readName === 'Get-Content' && ['-totalcount', '-tail'].includes(parameter))
            || (consumer === 'Select-Object' && ['-first', '-last', '-skip'].includes(parameter)))) {
            const value = words[++i]
            if (!value || !/^\d{1,7}$/.test(value.text)) unknown()
          } else if (consumer === 'Select-String' && parameter === '-pattern') {
            const value = words[++i]
            if (!value || value.parameter) unknown()
          } else if (consumer && parameter && (
            consumer === 'Select-String' && ['-simplematch', '-casesensitive', '-notmatch', '-allmatches'].includes(parameter)
            || consumer === 'Measure-Object' && ['-line', '-word', '-character'].includes(parameter)
            || consumer === 'Sort-Object' && ['-unique', '-descending', '-casesensitive'].includes(parameter)
          )) continue
          else unknown()
        }
        if (readName && !suppliedPath) {
          if (readName !== 'Get-ChildItem') unknown()
        }
      }
    }
    return { workingDir: cwd.canonicalPath, executable: script.executable, paths: [...paths] }
  }

  async function inspect(args: Readonly<Record<string, unknown>>, invocation?: SkillScriptInvocation): Promise<ShellCommandPlan | undefined> {
    options.signal?.throwIfAborted()
    if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
    if (typeof args.command !== 'string' || args.keep_processes === true || args.pty !== undefined) return undefined
    const command = args.command
    const workingDir = typeof args.working_dir === 'string' ? args.working_dir : options.primaryFolder
    let timer: NodeJS.Timeout | undefined
    try {
      const plan = await Promise.race([
        (async () => {
          const candidate = await analyze(command, workingDir, invocation)
          if (candidate && !candidate.skillScript && options.accessMode() === 'strict_approval') {
            const roots = await Promise.all(options.trustedFolders.map(async (root) =>
              (await resolveCanonicalWorkspacePath(root, options.primaryFolder, 'follow')).canonicalPath))
            if (candidate.paths.some((target) => !roots.some((root) => isSameOrInsideDirectory(root, target)))) return undefined
          }
          return candidate
        })(),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 5000) })
      ])
      return plan
    } catch { return undefined } finally { clearTimeout(timer); options.signal?.throwIfAborted() }
  }

  return {
    inspect,
    async requiresApproval(args: Readonly<Record<string, unknown>>): Promise<boolean> {
      options.signal?.throwIfAborted()
      if (options.accessMode() === 'full_access') return false
      return !await inspect(args)
    }
  }
}
