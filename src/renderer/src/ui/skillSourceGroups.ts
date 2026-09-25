import type { SkillRootSummary } from '@shared/types'

export interface SkillSourceGroup {
  id: string
  label: string
  roots: SkillRootSummary[]
}

export function skillSourceGroups(roots: SkillRootSummary[], t: (key: string) => string): SkillSourceGroup[] {
  return [
    ...(['system', 'user', 'project'] as const).map((kind) => ({
      id: kind,
      label: t(`settings.skill_group_${kind}`),
      roots: roots.filter((root) => root.kind === kind)
    })),
    ...roots.filter((root) => root.kind === 'external').map((root) => ({
      id: `external:${root.id}`, label: root.name, roots: [root]
    }))
  ]
}
