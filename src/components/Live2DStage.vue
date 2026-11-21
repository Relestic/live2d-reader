<script setup lang="ts">
import type { Live2DModel } from 'pixi-live2d-display/cubism4'

import type { InternalModelLike, MouthFrame } from '../lib/mouth'

import { Application } from '@pixi/app'
import { extensions } from '@pixi/extensions'
import { Ticker, TickerPlugin } from '@pixi/ticker'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { attachMouthWriter } from '../lib/mouth'

const props = defineProps<{
  readMouth: () => MouthFrame
}>()

type Framing = 'bust' | 'full'

const MODEL_URL = `${import.meta.env.BASE_URL}models/Hiyori/Hiyori.model3.json`
const FRAMING_KEY = 'hiyori-reader/framing'

const host = ref<HTMLDivElement>()
const state = ref<'loading' | 'ready' | 'error'>('loading')
const errorText = ref('')
const framing = ref<Framing>(localStorage.getItem(FRAMING_KEY) === 'full' ? 'full' : 'bust')

let unmounted = false
let teardown: (() => void) | undefined
let refit: (() => void) | undefined

// Registering twice (for example after a hot reload) would add a second render loop.
let pixiRegistered = false
function registerPixi(model: typeof Live2DModel) {
  if (pixiRegistered)
    return
  pixiRegistered = true
  // https://guansss.github.io/pixi-live2d-display/#package-importing , same setup as airi's Live2D canvas
  model.registerTicker(Ticker)
  extensions.add(TickerPlugin)
}

// Where Hiyori's eyes are, as a fraction of the model's size in its own coordinates.
const FACE_X = 0.5
const FACE_Y = 0.19
// How far the pointer has to be from her face, in CSS pixels, for her to turn as far as she can.
const GAZE_REACH = 520

/**
 * Hiyori looks at the mouse anywhere on the page, not only over her own canvas.
 * Model.focus() is not used because it always turns the head all the way, even when the
 * pointer is right next to her face; this turns her less the closer the pointer is.
 */
function followPointer(model: Live2DModel, canvas: HTMLCanvasElement) {
  const focus = model.internalModel.focusController

  const onMove = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect()
    // Live2DModel's local space runs from 0 to internalModel.width / height (it is what anchor uses).
    const face = model.toGlobal({
      x: model.internalModel.width * FACE_X,
      y: model.internalModel.height * FACE_Y,
    })
    let x = (event.clientX - box.left - face.x) / GAZE_REACH
    let y = (event.clientY - box.top - face.y) / GAZE_REACH
    const length = Math.hypot(x, y)
    if (length > 1) {
      x /= length
      y /= length
    }
    // Live2D's focus Y points up; the screen's points down.
    focus.focus(x, -y)
  }

  // The pointer left the window: look straight ahead again.
  const onLeave = (event: PointerEvent) => {
    if (!event.relatedTarget)
      focus.focus(0, 0)
  }
  const onHidden = () => focus.focus(0, 0)

  window.addEventListener('pointermove', onMove, { passive: true })
  document.addEventListener('pointerout', onLeave)
  window.addEventListener('blur', onHidden)
  return () => {
    window.removeEventListener('pointermove', onMove)
    document.removeEventListener('pointerout', onLeave)
    window.removeEventListener('blur', onHidden)
  }
}

function toggleFraming() {
  framing.value = framing.value === 'bust' ? 'full' : 'bust'
  localStorage.setItem(FRAMING_KEY, framing.value)
}

watch(framing, () => refit?.())

onMounted(async () => {
  const element = host.value
  if (!element)
    return

  // pixi-live2d-display checks for the Cubism Core when its module loads, so it is imported only after this check.
  if (!(window as unknown as Record<string, unknown>).Live2DCubismCore) {
    state.value = 'error'
    errorText.value = '缺少 Cubism Core（live2dcubismcore.min.js）。请重新运行 npm run dev，它会自动下载。'
    return
  }

  let app: Application | undefined
  try {
    const { Live2DModel: Live2DModelClass } = await import('pixi-live2d-display/cubism4')
    registerPixi(Live2DModelClass)
    if (unmounted)
      return

    app = new Application({
      width: Math.max(1, element.clientWidth),
      height: Math.max(1, element.clientHeight),
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
    })
    element.appendChild(app.view)

    let model: Live2DModel
    try {
      model = await Live2DModelClass.from(MODEL_URL, { autoInteract: false })
    }
    catch (error) {
      console.error(error)
      throw new Error('Hiyori 的模型文件没找到或读不了。请先运行 npm run setup 下载模型。')
    }

    if (unmounted) {
      model.destroy()
      app.destroy(true)
      return
    }

    app.stage.addChild(model)
    const baseWidth = model.width
    const baseHeight = model.height
    const stageApp = app

    const fit = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (!width || !height)
        return
      stageApp.renderer.resize(width, height)

      if (framing.value === 'full') {
        const scale = Math.min(width / baseWidth, height / baseHeight) * 0.96
        model.scale.set(scale)
        model.anchor.set(0.5, 0.5)
        model.position.set(width / 2, height / 2)
      }
      else {
        // Head to waist: about the top 45% of the model, so the mouth is large enough to follow.
        const scale = (height / baseHeight) * 2.2
        model.scale.set(scale)
        model.anchor.set(0.5, 0)
        model.position.set(width / 2, -height * 0.02)
      }
    }

    const observer = new ResizeObserver(fit)
    observer.observe(element)
    fit()
    refit = fit

    const detachMouth = attachMouthWriter(
      model.internalModel as unknown as InternalModelLike,
      () => props.readMouth(),
    )
    const detachGaze = followPointer(model, stageApp.view)

    state.value = 'ready'
    teardown = () => {
      observer.disconnect()
      detachMouth()
      detachGaze()
      stageApp.destroy(true, { children: true, texture: true, baseTexture: true })
    }
  }
  catch (error) {
    app?.destroy(true)
    state.value = 'error'
    errorText.value = error instanceof Error ? error.message : String(error)
  }
})

onBeforeUnmount(() => {
  unmounted = true
  refit = undefined
  teardown?.()
})
</script>

<template>
  <div class="stage">
    <div ref="host" class="stage-canvas" />
    <p v-if="state === 'loading'" class="stage-note">
      正在加载 Hiyori…
    </p>
    <p v-else-if="state === 'error'" class="stage-note is-error" role="alert">
      {{ errorText }}
    </p>
    <button
      v-if="state === 'ready'"
      type="button"
      class="stage-framing"
      @click="toggleFraming"
    >
      {{ framing === 'bust' ? '看全身' : '看特写' }}
    </button>
  </div>
</template>
