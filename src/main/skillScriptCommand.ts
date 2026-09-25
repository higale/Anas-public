import { basename } from 'node:path'

/** Recognize file execution, not arbitrary interpreter options or CLI wrappers.
 * The original command is never rebuilt from these words. */
export function scriptOperand(executable: string, args: readonly string[]): string | undefined {
  const name = basename(executable).toLowerCase().replace(/\.exe$/, '')
  let index = 0
  if (/^python(?:[23](?:\.\d+)*)?$/.test(name) || name === 'py') {
    if (name === 'py' && /^-[23](?:\.\d+)*$/.test(args[index] ?? '')) index++
    while (['-u', '-B', '-E', '-s', '-S', '-I', '-O', '-OO', '-b', '-bb'].includes(args[index])) index++
  } else if (['node', 'nodejs', 'ruby', 'perl', 'lua'].includes(name)) {
    // No preloads, loaders, module names, eval strings or interactive modes.
  } else if (['bash', 'sh', 'zsh'].includes(name)) {
    while (['-e', '-u', '-eu', '-ue'].includes(args[index])) index++
  } else if (name === 'pwsh' || name === 'powershell') {
    while (['-nologo', '-noprofile', '-noninteractive'].includes(args[index]?.toLowerCase())) index++
    if (args[index]?.toLowerCase() === '-executionpolicy') {
      if (!['bypass', 'remotesigned', 'allsigned', 'restricted', 'unrestricted', 'default'].includes(args[index + 1]?.toLowerCase())) return undefined
      index += 2
    }
    if (args[index]?.toLowerCase() !== '-file') return undefined
    index++
  } else return undefined
  if (args[index] === '--') index++
  const script = args[index]
  return script && !script.startsWith('-') && !/[\0\r\n]/.test(script) ? script : undefined
}
