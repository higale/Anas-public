import type { ReactNode } from 'react'

interface SettingsGroupProps {
  children: ReactNode
  className?: string
  description?: ReactNode
  title?: ReactNode
  titleAccessory?: ReactNode
}

export function SettingsGroup({ children, className = '', description, title, titleAccessory }: SettingsGroupProps) {
  return (
    <section className={['settings-group', className].filter(Boolean).join(' ')}>
      {(title || titleAccessory || description) && (
        <header className="settings-group-header">
          {(title || titleAccessory) && (
            <div className="settings-group-title-row">
              {title && <h2 className="settings-group-title">{title}</h2>}
              {titleAccessory}
            </div>
          )}
          {description && <div className="settings-group-description">{description}</div>}
        </header>
      )}
      <div className="settings-card">
        {children}
      </div>
    </section>
  )
}
