export function getSourceFolderName(folderPath: string): string {
  const pathWithoutTrailingSeparators = folderPath.replace(/[\\/]+$/, '')
  const lastSeparatorIndex = Math.max(
    pathWithoutTrailingSeparators.lastIndexOf('/'),
    pathWithoutTrailingSeparators.lastIndexOf('\\')
  )
  return pathWithoutTrailingSeparators.slice(lastSeparatorIndex + 1)
}
