import type { GitReferenceQuery, GitReferenceResult } from '@shared/gitChanges'
export function referenceFixture(input: GitReferenceQuery): GitReferenceResult {
  return { repositoryRoot: input.sourceFolder, hasMore: false, entries: input.kind === 'refs' ? [
    { value: 'HEAD', label: 'HEAD', commit: 'b'.repeat(40), group: 'head' },
    { value: 'refs/heads/main', label: 'main', commit: 'a'.repeat(40), group: 'local', current: true },
    { value: 'refs/remotes/origin/main', label: 'origin/main', commit: 'a'.repeat(40), group: 'remote' },
    { value: 'refs/tags/v1', label: 'v1', commit: 'a'.repeat(40), group: 'tag' }
  ] : [{ value: input.ref ?? 'c'.repeat(40), commit: input.ref ?? 'c'.repeat(40), label: 'Example commit', group: 'history' }] }
}
