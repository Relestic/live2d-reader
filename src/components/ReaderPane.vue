<script setup lang="ts">
import type { SweepCue } from '../composables/useReadAloud'

import { ref, watch } from 'vue'

const props = defineProps<{
  html: string
  current: number
  sweep: SweepCue | null
  paused: boolean
}>()

const emit = defineEmits<{
  pick: [index: number]
}>()

const scroller = ref<HTMLElement>()
const article = ref<HTMLElement>()
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

// After the reader scrolls by hand, the page stops following the voice for a while.
const FOLLOW_PAUSE_MS = 5000
let userScrolledAt = Number.NEGATIVE_INFINITY

function markUserScroll() {
  userScrolledAt = performance.now()
}

function spansOf(index: number) {
  if (!article.value || index < 0)
    return []
  return [...article.value.querySelectorAll<HTMLElement>(`[data-s="${index}"]`)]
}

function follow(element: HTMLElement) {
  const container = scroller.value
  if (!container || performance.now() - userScrolledAt < FOLLOW_PAUSE_MS)
    return
  const box = element.getBoundingClientRect()
  const view = container.getBoundingClientRect()
  const comfortable = box.top >= view.top + 64 && box.bottom <= view.bottom - 96
  if (!comfortable)
    element.scrollIntoView({ block: 'center', behavior: reduceMotion.matches ? 'auto' : 'smooth' })
}

watch(() => props.current, (index, previous) => {
  for (const element of spansOf(previous))
    element.classList.remove('is-current', 'is-sweeping')
  const spans = spansOf(index)
  for (const element of spans)
    element.classList.add('is-current')
  if (spans[0])
    follow(spans[0])
}, { flush: 'post' })

watch(() => props.sweep?.key, () => {
  const cue = props.sweep
  if (!cue) {
    // Waiting for new audio: fall back to the pale marker.
    for (const element of spansOf(props.current))
      element.classList.remove('is-sweeping')
    return
  }
  const spans = spansOf(cue.index)
  const lengths = spans.map(element => element.textContent?.length ?? 0)
  const total = lengths.reduce((sum, length) => sum + length, 0) || 1

  // A sentence split by inline formatting has several spans. Each one sweeps in turn,
  // for its share of the audio by character count, so the marker moves at an even pace.
  let done = 0
  spans.forEach((element, position) => {
    element.classList.remove('is-sweeping')
    element.style.setProperty('--sweep-delay', `${(done / total) * cue.duration}s`)
    element.style.setProperty('--sweep-duration', `${Math.max(0.05, (lengths[position] / total) * cue.duration)}s`)
    done += lengths[position]
  })
  // Reading layout here restarts the animation when the same sentence is played again.
  void article.value?.offsetWidth
  for (const element of spans)
    element.classList.add('is-current', 'is-sweeping')
}, { flush: 'post' })

watch(() => props.html, () => {
  scroller.value?.scrollTo({ top: 0 })
  userScrolledAt = Number.NEGATIVE_INFINITY
}, { flush: 'post' })

function onClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.closest('a'))
    return
  // Selecting text to copy it should not start reading.
  if (window.getSelection()?.toString())
    return
  const span = target.closest<HTMLElement>('[data-s]')
  if (span)
    emit('pick', Number(span.dataset.s))
}
</script>

<template>
  <div
    ref="scroller"
    class="reader"
    :class="{ 'is-paused': paused }"
    @wheel.passive="markUserScroll"
    @touchmove.passive="markUserScroll"
  >
    <!-- The HTML comes from segmentHtml, which removes scripts, event handlers and unsafe links. -->
    <!-- eslint-disable-next-line vue/no-v-html -->
    <article ref="article" class="doc" lang="zh-CN" @click="onClick" v-html="html" />
  </div>
</template>
