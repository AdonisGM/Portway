import { useSyncExternalStore } from 'react'
import { getLang, onLangChange } from '.'

/** The current language, re-rendering on change; for memoised values that call t(). */
export const useLang = () => useSyncExternalStore(onLangChange, getLang)
