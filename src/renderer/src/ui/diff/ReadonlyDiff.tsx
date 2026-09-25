import { useContext, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { editor } from 'monaco-editor'
import type { DiffContents } from '@shared/diffContents'
import { usePanelRef } from '../agent/PanelViewState'
import { DiffPreferences } from './DiffView'

export function ReadonlyDiff({ data, viewKey }: { data: DiffContents; viewKey: string }) {
  const { t } = useTranslation()
  const { diffViewMode: mode, diffFoldUnchanged: fold, diffWordWrap: wordWrap } = useContext(DiffPreferences)
  const host = useRef<HTMLDivElement>(null), instance = useRef<editor.IStandaloneDiffEditor | null>(null)
  const views = usePanelRef(`monaco:${viewKey}`, new Map<string, editor.IDiffEditorViewState>())
  const [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const modeRef = useRef(mode), foldRef = useRef(fold), wordWrapRef = useRef(wordWrap)
  modeRef.current = mode; foldRef.current = fold; wordWrapRef.current = wordWrap
  useEffect(() => {
    if (data.status !== 'ready' || !host.current) return
    let disposed = false, release = () => {}
    setError(''); setLoading(true)
    void import('./monacoRuntime').then(({ monaco, languageForPath }) => {
      if (disposed || !host.current) return
      const language = languageForPath(data.path)
      const original = monaco.editor.createModel(data.before, language)
      const cleanups: Array<() => void> = [() => original.dispose()]
      release = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() }
      const modified = monaco.editor.createModel(data.after, language)
      cleanups.push(() => modified.dispose())
      const diff = monaco.editor.createDiffEditor(host.current, {
        readOnly: true, domReadOnly: true, originalEditable: false, automaticLayout: true,
        renderSideBySide: modeRef.current === 'side_by_side', useInlineViewWhenSpaceIsLimited: false,
        diffWordWrap: wordWrapRef.current ? 'on' : 'off',
        renderMarginRevertIcon: false, renderGutterMenu: false, contextmenu: false,
        minimap: { enabled: false }, lineNumbers: 'on', scrollBeyondLastLine: false,
        ignoreTrimWhitespace: false, diffAlgorithm: 'advanced', maxComputationTime: 2000, maxFileSize: 2,
        hideUnchangedRegions: { enabled: foldRef.current, contextLineCount: 3, minimumLineCount: 8, revealLineCount: 20 },
        accessibilityVerbose: false, stickyScroll: { enabled: false }
      })
      cleanups.push(() => {
        const state = diff.saveViewState()
        if (state) views.current.set(modeRef.current, state)
        instance.current = null; diff.dispose()
      })
      instance.current = diff
      diff.setModel({ original, modified })
      const appearance = () => {
        const root = document.documentElement, styles = getComputedStyle(root)
        const dark = root.dataset.theme === 'dark'
        monaco.editor.defineTheme('anas-diff', { base: dark ? 'vs-dark' : 'vs', inherit: true, rules: [],
          colors: {
            'editor.background': styles.getPropertyValue('--bg-app').trim(),
            'editor.foreground': styles.getPropertyValue('--text').trim(),
            'editorLineNumber.foreground': styles.getPropertyValue('--text-muted').trim(),
            'editorLineNumber.activeForeground': styles.getPropertyValue('--text').trim(),
            'editorWidget.background': styles.getPropertyValue('--bg-surface').trim(),
            'editorWidget.border': styles.getPropertyValue('--border').trim(),
            'diffEditor.insertedLineBackground': styles.getPropertyValue('--diff-added-line-bg').trim(),
            'diffEditor.insertedTextBackground': styles.getPropertyValue('--diff-added-text-bg').trim(),
            'diffEditor.removedLineBackground': styles.getPropertyValue('--diff-removed-line-bg').trim(),
            'diffEditor.removedTextBackground': styles.getPropertyValue('--diff-removed-text-bg').trim()
          } })
        monaco.editor.setTheme('anas-diff')
        diff.updateOptions({ fontSize: parseFloat(styles.getPropertyValue('--font-size-base')) || 14,
          fontFamily: styles.getPropertyValue('--font-mono').trim() || 'monospace' })
      }
      appearance()
      const observer = new MutationObserver(appearance)
      cleanups.push(() => observer.disconnect())
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
      const saved = views.current.get(modeRef.current)
      if (saved) diff.restoreViewState(saved)
      const ready = diff.onDidUpdateDiff(() => {
        if (saved) diff.restoreViewState(saved)
        ready.dispose()
      })
      cleanups.push(() => ready.dispose())
      setLoading(false)
    }).catch((reason: unknown) => { release(); if (!disposed) { setLoading(false); setError(String(reason)) } })
    return () => { disposed = true; release() }
    // Display controls update the existing editor; text identity owns its lifetime.
  }, [data, views])
  useEffect(() => {
    // Inline mode disables wrapping in the hidden original editor. Reset that
    // override when changing layouts so both visible sides follow diffWordWrap.
    instance.current?.updateOptions({ renderSideBySide: mode === 'side_by_side', wordWrapOverride2: 'inherit' })
    const viewStates = views.current
    const saved = viewStates.get(mode)
    if (saved) instance.current?.restoreViewState(saved)
    return () => {
      const state = instance.current?.saveViewState()
      if (state) viewStates.set(mode, state)
    }
  }, [mode, views])
  useEffect(() => { instance.current?.updateOptions({ hideUnchangedRegions: { enabled: fold } }) }, [fold])
  useEffect(() => { instance.current?.updateOptions({ diffWordWrap: wordWrap ? 'on' : 'off' }) }, [wordWrap])

  if (data.status === 'unavailable') return <p role="status" className="ui-field-hint">{t(`diff.unavailable_${data.reason}`)}</p>
  return <div className="ui-readonly-diff">
      {(!data.beforeExists || !data.afterExists) && <p className="ui-field-hint">{t(!data.beforeExists && !data.afterExists ? 'diff.not_present' : data.beforeExists ? 'diff.deleted' : 'diff.added')}</p>}
      {data.beforeExists && data.afterExists && data.before === data.after && <p className="ui-field-hint">{t('diff.no_text_change')}</p>}
    {loading && <p role="status">{t('common.loading')}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="ui-diff-editor" ref={host} aria-label={t('diff.readonly')} />
  </div>
}
