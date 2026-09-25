import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultProjectIcon, PROJECT_ICON_COLORS, PROJECT_ICON_NAMES } from '@shared/projectAppearance'
import type { ProjectIconColor, ProjectIconName, ProjectKind } from '@shared/types'
import { ProjectIcon } from './ProjectIcon'

interface ProjectAppearancePickerProps {
  color?: ProjectIconColor
  icon?: ProjectIconName
  kind: ProjectKind
  onChangeColor(color?: ProjectIconColor): void
  onChangeIcon(icon: ProjectIconName): void
}

export function ProjectAppearancePicker({
  color,
  icon,
  kind,
  onChangeColor,
  onChangeIcon
}: ProjectAppearancePickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          className="ui-dialog-icon project-appearance-trigger"
          type="button"
          aria-label={t('project.choose_icon')}
        >
          <ProjectIcon color={color} icon={icon} kind={kind} size={18} />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent
          className="project-appearance-popover ui-popover"
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
        >
          <div className="project-icon-colors" aria-label={t('project.icon_color')} role="group">
            <button
              className="project-icon-color project-icon-color-auto"
              type="button"
              aria-label={t('project.icon_color_auto')}
              aria-pressed={!color}
              onClick={() => onChangeColor(undefined)}
            />
            {PROJECT_ICON_COLORS.map((option) => (
              <button
                className="project-icon-color"
                type="button"
                key={option}
                aria-label={t('project.icon_color_option', { color: t(`project.color_${option}`) })}
                aria-pressed={color === option}
                style={{ '--project-icon-option-color': `var(--project-icon-${option})` } as CSSProperties}
                onClick={() => onChangeColor(option)}
              />
            ))}
          </div>
          <div className="project-appearance-separator" />
          <div className="project-icon-options" aria-label={t('project.icon')} role="group">
            {PROJECT_ICON_NAMES.map((option, index) => (
              <button
                className="project-icon-option"
                type="button"
                key={option}
                aria-label={t('project.icon_option', { index: index + 1 })}
                aria-pressed={option === (icon ?? defaultProjectIcon(kind))}
                onClick={() => onChangeIcon(option)}
              >
                <ProjectIcon color={color} icon={option} kind={kind} size={18} />
              </button>
            ))}
          </div>
          <footer className="project-appearance-footer">
            <Popover.Close asChild>
              <button className="ui-button ui-button-compact" type="button">{t('common.done')}</button>
            </Popover.Close>
          </footer>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}
