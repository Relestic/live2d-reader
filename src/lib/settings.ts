import type { TtsSettings } from './cosyvoice'

import { defaultSettings } from './cosyvoice'

const STORAGE_KEY = 'hiyori-reader/settings'

export function loadSettings(): TtsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw)
      return { ...defaultSettings, ...JSON.parse(raw) as Partial<TtsSettings> }
  }
  catch {
    // A broken entry falls back to the defaults.
  }
  return { ...defaultSettings }
}

export function saveSettings(settings: TtsSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  }
  catch {
    // Private mode or a full quota: the settings only last for this visit.
  }
}
