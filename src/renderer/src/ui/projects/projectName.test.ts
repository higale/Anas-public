import { describe, expect, it } from 'vitest'
import { getSourceFolderName } from './projectName'

describe('getSourceFolderName', () => {
  it('returns the final directory from Windows paths', () => {
    expect(getSourceFolderName('D:\\Work\\Anas')).toBe('Anas')
    expect(getSourceFolderName('D:\\Work\\Anas\\')).toBe('Anas')
  })

  it('returns the final directory from POSIX paths', () => {
    expect(getSourceFolderName('/Users/user/Anas')).toBe('Anas')
    expect(getSourceFolderName('/Users/user/Anas/')).toBe('Anas')
  })
})
