import type { WLipSyncVowelWeights } from '../lipsync'

/** What the mouth should do on this frame. `open` and `form` are already in Hiyori's parameter ranges. */
export interface MouthFrame {
  speaking: boolean
  /** ParamMouthOpenY, 0 to 1. */
  open: number
  /** ParamMouthForm, -1 to 1. */
  form: number
}

export const silentMouth: MouthFrame = { speaking: false, open: 0, form: 0 }

/**
 * Hiyori has no per-vowel mouth parameters, only ParamMouthOpenY and ParamMouthForm.
 * The vowel weights choose the mouth shape instead: I and E widen it, U and O round it.
 * The range stops short of -1, which Hiyori draws as a frown.
 */
export function vowelsToMouthForm(weights: WLipSyncVowelWeights): number {
  const total = weights.A + weights.E + weights.I + weights.O + weights.U
  if (total < 0.02)
    return 0
  const shape = (weights.I + weights.E * 0.6 - weights.U * 0.5 - weights.O * 0.3) / total
  return Math.max(-0.4, Math.min(0.8, shape))
}

interface CoreModelLike {
  getParameterValueById: (id: string) => number
  setParameterValueById: (id: string, value: number) => void
}

/** The part of pixi-live2d-display's InternalModel this file needs. */
export interface InternalModelLike {
  coreModel: CoreModelLike
  on: (event: string, listener: () => void) => unknown
  off: (event: string, listener: () => void) => unknown
}

// The timings follow useMotionUpdatePluginLipSync in airi's stage-ui-live2d:
// a 200 ms release tail, then the mouth is held shut for 500 ms before the idle motion gets it back.
const RELEASE_MS = 200
const HANDOFF_HOLD_MS = 500

const smoothstep = (t: number) => t * t * (3 - 2 * t)

/**
 * Writes the mouth into the model on every frame.
 *
 * pixi-live2d-display emits `beforeModelUpdate` after motions, physics and pose have run and before the
 * Cubism model is updated, so a value written here wins over the idle motion for that frame.
 * The model restores its saved parameters right after the update, so nothing accumulates across frames.
 *
 * @returns A function that detaches the writer.
 */
export function attachMouthWriter(internalModel: InternalModelLike, read: () => MouthFrame) {
  let lastTime = performance.now()
  let releaseLeft = 0
  let holdLeft = 0
  let lastOpen = 0
  let lastForm = 0

  const onBeforeModelUpdate = () => {
    const now = performance.now()
    const deltaMs = Math.min(100, now - lastTime)
    lastTime = now

    const core = internalModel.coreModel
    const frame = read()

    if (frame.speaking) {
      lastOpen = frame.open
      lastForm = frame.form
      releaseLeft = RELEASE_MS
      holdLeft = HANDOFF_HOLD_MS
      core.setParameterValueById('ParamMouthOpenY', frame.open)
      core.setParameterValueById('ParamMouthForm', frame.form)
      return
    }

    if (releaseLeft > 0) {
      releaseLeft = Math.max(0, releaseLeft - deltaMs)
      const blend = smoothstep(1 - releaseLeft / RELEASE_MS)
      const motionForm = core.getParameterValueById('ParamMouthForm')
      core.setParameterValueById('ParamMouthOpenY', lastOpen * (1 - blend))
      core.setParameterValueById('ParamMouthForm', lastForm * (1 - blend) + motionForm * blend)
      return
    }

    if (holdLeft > 0) {
      holdLeft = Math.max(0, holdLeft - deltaMs)
      core.setParameterValueById('ParamMouthOpenY', 0)
    }
  }

  internalModel.on('beforeModelUpdate', onBeforeModelUpdate)
  return () => {
    internalModel.off('beforeModelUpdate', onBeforeModelUpdate)
  }
}
