import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod/v3'

const execFileAsync = promisify(execFile)

// ParseInput only constructs an AST. Never dot-source, invoke or expand the input.
const parserProgram = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = $env:ANAS_SHELL_ANALYSIS_SOURCE
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
try {
  if ($errors.Count -or $ast.ScriptRequirements -or $ast.ParamBlock -or $ast.UsingStatements.Count -or $ast.BeginBlock -or $ast.ProcessBlock -or $ast.DynamicParamBlock -or $ast.CleanBlock -or !$ast.EndBlock.Unnamed -or $ast.EndBlock.Traps.Count) { throw 'Unsupported script structure' }
  if ($tokens.Where({ $_.Text -eq '--%' }).Count) { throw 'Stop-parsing syntax' }
  $pipelines = @()
  foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -isnot [System.Management.Automation.Language.PipelineAst] -or $statement.Background) { throw 'Unsupported statement' }
    $commands = @()
    foreach ($command in $statement.PipelineElements) {
      if ($command -isnot [System.Management.Automation.Language.CommandAst] -or $command.Redirections.Count -or $command.InvocationOperator -eq 'Dot') { throw 'Unsupported command or redirection' }
      $words = @()
      foreach ($element in $command.CommandElements) {
        $parameter = $false
        if ($element -is [System.Management.Automation.Language.CommandParameterAst]) {
          if ($element.Argument) { throw 'Inline PowerShell parameter expression' }
          $value = '-' + $element.ParameterName
          $parameter = $true
        } elseif ($element -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
          $value = $element.Value
        } elseif ($element -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and !$element.NestedExpressions.Count) {
          $value = $element.Value
        } elseif ($element -is [System.Management.Automation.Language.ConstantExpressionAst] -and $element.Value -is [ValueType]) {
          $value = $element.Extent.Text
        } else { throw 'Dynamic argument' }
        $words += @{ text = [string]$value; parameter = $parameter }
      }
      # Resolve in the same no-profile environment and working directory as the
      # tool. A familiar spelling is not proof of which command would run.
      $resolved = Microsoft.PowerShell.Core\Get-Command -Name $words[0].text -ErrorAction Stop | Select-Object -First 1
      if ($resolved -is [System.Management.Automation.AliasInfo]) { $resolved = $resolved.ResolvedCommand }
      $commands += @{ words = @($words); commandType = [string]$resolved.CommandType; source = [string]$resolved.Source; resolvedName = [string]$resolved.Name }
    }
    $pipelines += @{ commands = @($commands) }
  }
  @{ pipelines = @($pipelines); executable = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName } | ConvertTo-Json -Depth 8 -Compress
} catch { @{ unsupported = $true } | ConvertTo-Json -Compress }
`

const word = z.object({ text: z.string().max(16384), parameter: z.boolean() })
const parsedScript = z.object({
  executable: z.string().min(1),
  pipelines: z.array(z.object({ commands: z.array(z.object({ words: z.array(word).min(1).max(128),
    commandType: z.string(), source: z.string(), resolvedName: z.string() })).min(1).max(16) })).min(1).max(32)
})
export type PowerShellWord = z.infer<typeof word>

export async function parsePowerShellCommands(command: string, executable: string, env: NodeJS.ProcessEnv, signal?: AbortSignal, cwd?: string) {
  if (!command.trim() || command.length > 16384 || command.includes('\0')) return undefined
  try {
    const { stdout } = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parserProgram], {
      windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024, signal, cwd,
      env: { ...env, ANAS_SHELL_ANALYSIS_SOURCE: command }
    })
    const result = parsedScript.safeParse(JSON.parse(stdout))
    return result.success ? result.data : undefined
  } catch { return undefined }
}
