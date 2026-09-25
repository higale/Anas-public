import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'

const PanelViewContext = createContext<Map<string, unknown> | undefined>(undefined)

export function PanelViewState({ state, children }: { state: Map<string, unknown>; children: ReactNode }) {
  return <PanelViewContext.Provider value={state}>{children}</PanelViewContext.Provider>
}

/** View preferences only; model history continues to belong to the runtime. */
export function usePanelState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(PanelViewContext)
  const [value, setValue] = useState<T>(() => store?.has(key) ? store.get(key) as T : typeof initial === 'function' ? (initial as () => T)() : initial)
  useLayoutEffect(() => { store?.set(key, value) }, [key, store, value])
  return [value, setValue]
}

export function usePanelScroll(ref: RefObject<HTMLElement | null>, ready: boolean, active = true, key = 'scrollTop') {
  const store = useContext(PanelViewContext)
  const restored = useRef(false)
  const saved = useRef((store?.get(key) as number | undefined) ?? 0)
  useLayoutEffect(() => {
    if (!active || !ready || !ref.current) return
    ref.current.scrollTop = saved.current
    restored.current = true
  }, [active, ready, ref])
  return useCallback(() => {
    if (!active || !ready || !restored.current || !ref.current) return
    saved.current = ref.current.scrollTop
    store?.set(key, saved.current)
  }, [active, ready, ref, store, key])
}

export function usePanelRef<T>(key: string, initial: T) {
  const store = useContext(PanelViewContext)
  const local = useRef(initial)
  const ref = store?.has(key) ? store.get(key) as typeof local : local
  useLayoutEffect(() => { store?.set(key, ref) }, [key, ref, store])
  return ref
}

export function usePanelDisclosure(key: string, defaultOpen: boolean, trackOpen = false) {
  const store = useContext(PanelViewContext)
  const [open, setOpen] = usePanelState(`expanded:${key}`, defaultOpen)
  return store || trackOpen ? { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open) }
    : { open: defaultOpen || undefined }
}
