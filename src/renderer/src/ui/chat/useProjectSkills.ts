import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillSnapshot } from '@shared/types'
import { notice } from '../notice'

export function useProjectSkills(projectId: string, globalSkills: SkillSnapshot | undefined, sourceFolders?: string[]): SkillSnapshot | undefined {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<{ projectId: string; sourceFolders?: string[]; snapshot: SkillSnapshot }>()

  useEffect(() => {
    let cancelled = false
    void window.gale.skills.get(projectId, sourceFolders).then((snapshot) => {
      if (!cancelled) setLoaded({ projectId, sourceFolders, snapshot })
    }).catch(() => {
      if (!cancelled) notice.error(t('chat.failed_load_skill'))
    })
    return () => { cancelled = true }
  }, [projectId, sourceFolders, globalSkills, t])

  return loaded?.projectId === projectId && loaded.sourceFolders === sourceFolders ? loaded.snapshot : undefined
}
