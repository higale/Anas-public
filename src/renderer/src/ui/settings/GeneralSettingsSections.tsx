import type { ComponentProps } from 'react'
import { AppearanceSettings } from './AppearanceSettings'
import { DataManagementSettings } from './DataManagementSettings'
import { ProfileSettings } from './ProfileSettings'

interface GeneralSettingsSectionsProps {
  className: string
  profile: ComponentProps<typeof ProfileSettings>
  appearance: ComponentProps<typeof AppearanceSettings>
  data: ComponentProps<typeof DataManagementSettings>
}

export function GeneralSettingsSections({ className, profile, appearance, data }: GeneralSettingsSectionsProps) {
  return <>
    <section className={className}>
      <ProfileSettings {...profile} />
    </section>
    <section className={className}>
      <AppearanceSettings {...appearance} />
    </section>
    <section className={className}>
      <DataManagementSettings {...data} />
    </section>
  </>
}
