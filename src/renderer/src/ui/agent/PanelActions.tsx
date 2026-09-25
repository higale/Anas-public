import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const PanelActionsTarget = createContext<HTMLElement | null>(null)

/** Render actions into the active panel's toolbar. */
export function PanelActions({ children }: { children: ReactNode }) {
  const target = useContext(PanelActionsTarget)
  return target ? createPortal(children, target) : null
}
