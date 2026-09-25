function isValidSkillShortcutName(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
}

export function parseSlashSkillInput(value: string): { name: string; sourceAlias?: string; args: string } | undefined {
  const trimmed = value.trim()
  if (!trimmed.startsWith('/') || trimmed.length <= 1) return undefined
  const body = trimmed.slice(1)
  const space = body.search(/\s/)
  const command = (space < 0 ? body : body.slice(0, space)).trim()
  const separator = command.lastIndexOf('@')
  const name = separator < 0 ? command : command.slice(0, separator)
  const sourceAlias = separator < 0 ? undefined : command.slice(separator + 1)
  if (!isValidSkillShortcutName(name)) return undefined
  if (sourceAlias !== undefined && !isValidSkillShortcutName(sourceAlias)) return undefined
  return {
    name,
    ...(sourceAlias ? { sourceAlias } : {}),
    args: space < 0 ? '' : body.slice(space + 1).trim()
  }
}
