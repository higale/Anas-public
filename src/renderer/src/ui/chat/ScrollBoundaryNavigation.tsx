import { ArrowDownToLine, ArrowUpToLine } from 'lucide-react'
import {
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject,
  type TouchEventHandler,
  type WheelEventHandler,
  useCallback,
  useEffect,
  useRef,
  useState
} from 'react'
import { NoFocusButton } from '../NoFocusButton'
import { useTranslation } from 'react-i18next'
import {
  followOutputPosition,
  observeFollowOutputGrowth,
  scrollToFollowOutput,
  updateFollowOutputAfterScroll,
  type FollowOutputState
} from './followOutput'

type ScrollBoundaryState = {
  atBottom: boolean
  atTop: boolean
  hasOverflow: boolean
}

const boundaryEpsilon = 1

export function scrollBoundaryState(
  panel: Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>
): ScrollBoundaryState {
  const bottomDistance = panel.scrollHeight - panel.scrollTop - panel.clientHeight
  return {
    atBottom: bottomDistance <= boundaryEpsilon,
    atTop: panel.scrollTop <= boundaryEpsilon,
    hasOverflow: panel.scrollHeight - panel.clientHeight > boundaryEpsilon
  }
}

function sameBoundaryState(left: ScrollBoundaryState, right: ScrollBoundaryState): boolean {
  return left.atBottom === right.atBottom
    && left.atTop === right.atTop
    && left.hasOverflow === right.hasOverflow
}

export function shouldShowScrollBoundaryControls(
  userInteracted: boolean,
  boundaries: ScrollBoundaryState
): boolean {
  return userInteracted && boundaries.hasOverflow && !boundaries.atBottom
}

export function pauseFollowOutputForContentToggle(
  target: EventTarget | null,
  followOutput: FollowOutputState
): boolean {
  if (!(target instanceof Element)) return false
  const toggle = target.closest('summary, [data-scroll-follow-toggle]')
  if (!toggle || toggle.getAttribute('aria-disabled') === 'true' || toggle.matches(':disabled')) return false
  followOutput.current = false
  return true
}

export function useScrollBoundaryNavigation({
  contentRef,
  contentVersion,
  enabled = true,
  followOutputRef,
  panelRef,
  followThreshold = 48,
  resetKey
}: {
  contentRef: RefObject<HTMLElement | null>
  contentVersion?: unknown
  enabled?: boolean
  followOutputRef: FollowOutputState
  panelRef: RefObject<HTMLElement | null>
  followThreshold?: number
  resetKey?: unknown
}) {
  const [boundaries, setBoundaries] = useState<ScrollBoundaryState>({
    atBottom: true,
    atTop: true,
    hasOverflow: false
  })
  const [userInteracted, setUserInteracted] = useState(false)
  const previousPositionRef = useRef({ scrollTop: 0 })
  const scrollbarDragRef = useRef(false)
  const scrollbarReleaseFrameRef = useRef<number | undefined>(undefined)
  const touchYRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    scrollbarDragRef.current = false
    if (scrollbarReleaseFrameRef.current !== undefined) window.cancelAnimationFrame(scrollbarReleaseFrameRef.current)
    scrollbarReleaseFrameRef.current = undefined
    touchYRef.current = undefined
    setUserInteracted(false)
  }, [resetKey])

  useEffect(() => {
    const cancelDrag = () => {
      if (scrollbarReleaseFrameRef.current !== undefined) window.cancelAnimationFrame(scrollbarReleaseFrameRef.current)
      scrollbarReleaseFrameRef.current = undefined
      scrollbarDragRef.current = false
    }
    const endDrag = () => {
      if (!scrollbarDragRef.current || scrollbarReleaseFrameRef.current !== undefined) return
      // Chromium can deliver a track click's first scroll after pointerup.
      // Keep its intent through that frame, never until unrelated layout work.
      scrollbarReleaseFrameRef.current = window.requestAnimationFrame(() => {
        const panel = panelRef.current
        if (panel) previousPositionRef.current = updateFollowOutputAfterScroll(
          panel, followOutputRef, previousPositionRef.current, true, followThreshold
        )
        scrollbarReleaseFrameRef.current = undefined
        scrollbarDragRef.current = false
      })
    }
    window.addEventListener('pointerup', endDrag, true)
    window.addEventListener('pointercancel', cancelDrag, true)
    window.addEventListener('blur', cancelDrag)
    return () => {
      cancelDrag()
      window.removeEventListener('pointerup', endDrag, true)
      window.removeEventListener('pointercancel', cancelDrag, true)
      window.removeEventListener('blur', cancelDrag)
    }
  }, [followOutputRef, followThreshold, panelRef])

  const updateBoundaries = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    const next = scrollBoundaryState(panel)
    setBoundaries((current) => sameBoundaryState(current, next) ? current : next)
  }, [panelRef])

  useEffect(() => {
    if (!enabled) return
    const panel = panelRef.current
    const content = contentRef.current
    if (!panel || !content) return
    previousPositionRef.current = followOutputPosition(panel)
    updateBoundaries()
    return observeFollowOutputGrowth(panel, content, followOutputRef, {
      onResize: updateBoundaries
    })
  }, [contentRef, enabled, followOutputRef, panelRef, updateBoundaries])

  useEffect(() => {
    if (!enabled || contentVersion === undefined) return
    const panel = panelRef.current
    if (!panel) return
    if (scrollToFollowOutput(panel, followOutputRef)) updateBoundaries()
  }, [contentVersion, enabled, followOutputRef, panelRef, updateBoundaries])

  const markUserInteraction = useCallback((upward: boolean) => {
    // Pause on input, before the browser scrolls or output changes the geometry.
    const panel = panelRef.current
    if (panel) previousPositionRef.current = followOutputPosition(panel)
    if (upward && panel && panel.scrollTop > 0) followOutputRef.current = false
    setUserInteracted(true)
  }, [followOutputRef, panelRef])
  const onClickCapture = useCallback<MouseEventHandler<HTMLElement>>((event) => {
    if (!pauseFollowOutputForContentToggle(event.target, followOutputRef)) return
    setUserInteracted(true)
  }, [followOutputRef])
  const onScroll = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    previousPositionRef.current = updateFollowOutputAfterScroll(
      panel,
      followOutputRef,
      previousPositionRef.current,
      scrollbarDragRef.current,
      followThreshold
    )
    updateBoundaries()
  }, [followOutputRef, followThreshold, panelRef, updateBoundaries])
  const onPointerDown = useCallback<PointerEventHandler<HTMLElement>>((event) => {
    const panel = event.currentTarget
    const scrollbarWidth = Math.max(panel.offsetWidth - panel.clientWidth, 4)
    if (event.clientX >= panel.getBoundingClientRect().right - scrollbarWidth) {
      if (scrollbarReleaseFrameRef.current !== undefined) window.cancelAnimationFrame(scrollbarReleaseFrameRef.current)
      scrollbarReleaseFrameRef.current = undefined
      scrollbarDragRef.current = true
      markUserInteraction(false)
    }
  }, [markUserInteraction])
  const onTouchStart = useCallback<TouchEventHandler<HTMLElement>>((event) => {
    touchYRef.current = event.touches[0]?.clientY
  }, [])
  const onTouchMove = useCallback<TouchEventHandler<HTMLElement>>(
    (event) => {
      const y = event.touches[0]?.clientY
      if (y !== undefined && touchYRef.current !== undefined) markUserInteraction(y > touchYRef.current)
      touchYRef.current = y
    },
    [markUserInteraction]
  )
  const onWheel = useCallback<WheelEventHandler<HTMLElement>>(
    (event) => { if (event.deltaY && !event.ctrlKey) markUserInteraction(event.deltaY < 0) },
    [markUserInteraction]
  )
  const onKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.altKey) return
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]')) return
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) markUserInteraction(true)
  }, [markUserInteraction])
  useEffect(() => {
    const panel = panelRef.current
    if (!enabled || !panel) return
    panel.addEventListener('keydown', onKeyDown)
    return () => panel.removeEventListener('keydown', onKeyDown)
  }, [enabled, onKeyDown, panelRef])
  const scrollToTop = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    followOutputRef.current = false
    setUserInteracted(true)
    panel.scrollTo({ top: 0, behavior: 'smooth' })
  }, [followOutputRef, panelRef])
  const scrollToBottom = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    followOutputRef.current = true
    setUserInteracted(true)
    panel.scrollTo({ top: panel.scrollHeight, behavior: 'smooth' })
  }, [followOutputRef, panelRef])

  return {
    boundaries,
    onClickCapture,
    onPointerDown,
    onScroll,
    onTouchMove,
    onTouchStart,
    onWheel,
    scrollToBottom,
    scrollToTop,
    showControls: shouldShowScrollBoundaryControls(userInteracted, boundaries)
  }
}

export function ScrollBoundaryControls({
  atBottom,
  atTop,
  onScrollToBottom,
  onScrollToTop,
  visible
}: {
  atBottom: boolean
  atTop: boolean
  onScrollToBottom(): void
  onScrollToTop(): void
  visible: boolean
}) {
  const { t } = useTranslation()
  if (!visible) return null
  return (
    <div className="scroll-boundary-controls">
      {!atTop && (
        <NoFocusButton
          className="scroll-boundary-button scroll-boundary-button-top ui-tool-button"
          type="button"
          aria-label={t('common.scroll_to_top')}
          data-tooltip={t('common.scroll_to_top')}
          onClick={onScrollToTop}
        >
          <ArrowUpToLine size={16} />
        </NoFocusButton>
      )}
      {!atBottom && (
        <NoFocusButton
          className="scroll-boundary-button scroll-boundary-button-bottom ui-tool-button"
          type="button"
          aria-label={t('common.scroll_to_bottom')}
          data-tooltip={t('common.scroll_to_bottom')}
          onClick={onScrollToBottom}
        >
          <ArrowDownToLine size={16} />
        </NoFocusButton>
      )}
    </div>
  )
}
