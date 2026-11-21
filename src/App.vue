<script setup lang="ts">
import type { ReadableDocument } from './lib/docx'

import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import Live2DStage from './components/Live2DStage.vue'
import ReaderPane from './components/ReaderPane.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import { useReadAloud } from './composables/useReadAloud'
import { DEFAULT_PROMPT_TEXT } from './lib/cosyvoice'
import { readDocx, segmentHtml } from './lib/docx'
import { describeError, ReaderError } from './lib/errors'
import { sampleHtml, sampleTitle } from './lib/sample'
import { loadSettings, saveSettings } from './lib/settings'

const PREVIEW_TEXT = '你好，我是日和。接下来由我把这份文档读给你听。'

const settings = ref(loadSettings())
watch(settings, value => saveSettings(value), { deep: true })

const doc = shallowRef<ReadableDocument | null>(null)
const docName = ref('')
const loadError = ref('')
const settingsOpen = ref(false)
const dragging = ref(false)
const fileInput = ref<HTMLInputElement>()
const promptFile = shallowRef<File | null>(null)

const sentences = computed(() => doc.value?.sentences ?? [])

let defaultPrompt: Promise<Blob> | null = null
function getPromptWav(): Promise<Blob | null> {
  if (promptFile.value)
    return Promise.resolve(promptFile.value)
  if (!defaultPrompt) {
    defaultPrompt = fetch(`${import.meta.env.BASE_URL}voice/zero_shot_prompt.wav`).then((response) => {
      // Vite answers a missing file with index.html and status 200, hence the content-type check.
      if (!response.ok || response.headers.get('content-type')?.includes('text/html'))
        throw new ReaderError('自带的参考音频没找到。请先运行 npm run setup，或者在朗读设置里上传一段参考音频。')
      return response.blob()
    })
    defaultPrompt.catch(() => {
      defaultPrompt = null
    })
  }
  return defaultPrompt
}

const reader = useReadAloud(sentences, settings, getPromptWav)
const { current, status, message, sweep, preparedCount, speakableCount, synthesizing, synthError, workingOn } = reader

// Ticks once a second while the server works, so a slow or stuck request shows how long it has taken.
const now = ref(Date.now())
const clock = window.setInterval(() => {
  if (workingOn.value)
    now.value = Date.now()
}, 1000)
onBeforeUnmount(() => window.clearInterval(clock))

const prepareText = computed(() => {
  if (!doc.value || !speakableCount.value)
    return ''
  if (synthError.value)
    return `后台合成停了：${synthError.value}`
  if (preparedCount.value >= speakableCount.value)
    return `全文 ${speakableCount.value} 句都合成好了，已存在浏览器里，下次打开不用再合成。`
  const working = workingOn.value
  const detail = working
    ? `，第 ${ranks.value[working.index]} 句已等 ${Math.max(0, Math.round((now.value - working.since) / 1000))} 秒`
    : (synthesizing.value ? '' : '（等待中）')
  return `后台合成中：${preparedCount.value} / ${speakableCount.value} 句${detail}`
})

const isActive = computed(() => status.value === 'playing' || status.value === 'loading')

// Position among the sentences that are read aloud, for the "第 n 句" counter.
const ranks = computed(() => {
  let count = 0
  return sentences.value.map(sentence => (sentence.speakable ? ++count : count))
})
const speakableTotal = computed(() => ranks.value.at(-1) ?? 0)
const position = computed(() => (current.value >= 0 ? ranks.value[current.value] : 0))
const progress = computed(() => (speakableTotal.value ? position.value / speakableTotal.value : 0))

const statusText = computed(() => {
  switch (status.value) {
    case 'loading':
      return message.value || `正在合成第 ${position.value} 句…`
    case 'playing':
      return message.value || '正在朗读'
    case 'paused':
      return '已暂停'
    case 'error':
      return message.value
    case 'done':
      return '读完了。'
    default:
      return message.value || (doc.value ? '按空格键开始，或者点任意一句从那里读起。' : '')
  }
})

function show(next: ReadableDocument, name: string) {
  reader.reset()
  doc.value = next
  docName.value = name
  loadError.value = ''
}

async function openFile(file: File) {
  try {
    show(await readDocx(file), file.name)
  }
  catch (error) {
    loadError.value = describeError(error)
  }
}

function loadSample() {
  show(segmentHtml(sampleHtml), sampleTitle)
}

function onFileChosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (file)
    void openFile(file)
}

function onUploadPrompt(file: File) {
  promptFile.value = file
  // The default transcript belongs to the default audio, so it has to be rewritten for the new one.
  settings.value.promptText = ''
  reader.invalidateVoice()
}

function onResetPrompt() {
  promptFile.value = null
  settings.value.promptText = DEFAULT_PROMPT_TEXT
  reader.invalidateVoice()
}

// Drag a .docx anywhere onto the window to open it.
function hasFiles(event: DragEvent) {
  return event.dataTransfer?.types.includes('Files') ?? false
}
function onDragOver(event: DragEvent) {
  if (!hasFiles(event))
    return
  event.preventDefault()
  dragging.value = true
}
function onDragLeave(event: DragEvent) {
  if (!event.relatedTarget)
    dragging.value = false
}
function onDrop(event: DragEvent) {
  if (!hasFiles(event))
    return
  event.preventDefault()
  dragging.value = false
  const file = event.dataTransfer?.files[0]
  if (file)
    void openFile(file)
}

function onKeydown(event: KeyboardEvent) {
  if (!doc.value || settingsOpen.value || event.altKey || event.ctrlKey || event.metaKey)
    return
  const target = event.target as HTMLElement | null
  // Buttons are not excluded: preventDefault below stops a focused button from also reacting to Space.
  if (target?.closest('input, textarea, select, [contenteditable]'))
    return

  if (event.code === 'Space') {
    event.preventDefault()
    reader.toggle()
  }
  else if (event.key === 'ArrowRight') {
    event.preventDefault()
    reader.step(1)
  }
  else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    reader.step(-1)
  }
}

onMounted(() => {
  window.addEventListener('dragover', onDragOver)
  window.addEventListener('dragleave', onDragLeave)
  window.addEventListener('drop', onDrop)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('dragover', onDragOver)
  window.removeEventListener('dragleave', onDragLeave)
  window.removeEventListener('drop', onDrop)
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="app">
    <header class="topbar">
      <h1 class="doc-title" :title="docName || undefined">
        {{ docName || 'Hiyori 朗读器' }}
      </h1>
      <div class="topbar-actions">
        <button type="button" class="btn" @click="fileInput?.click()">
          打开文档
        </button>
        <button type="button" class="btn" @click="settingsOpen = true">
          朗读设置
        </button>
      </div>
      <input
        ref="fileInput"
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        class="visually-hidden"
        tabindex="-1"
        aria-hidden="true"
        @change="onFileChosen"
      >
    </header>

    <main class="reading">
      <p v-if="doc && loadError" class="banner-error" role="alert">
        {{ loadError }}
      </p>
      <ReaderPane
        v-if="doc"
        :html="doc.html"
        :current="current"
        :sweep="sweep"
        :paused="status === 'paused'"
        @pick="reader.playFrom"
      />
      <section v-else class="empty">
        <h2 class="empty-title">
          把 Word 文档拖到这里
        </h2>
        <p class="empty-text">
          Hiyori 会一句一句读出来，读到哪句，荧光笔就划到哪句。点任意一句，可以从那里接着读。
        </p>
        <div class="empty-actions">
          <button type="button" class="btn btn-primary" @click="fileInput?.click()">
            打开 .docx 文档
          </button>
          <button type="button" class="btn" @click="loadSample">
            先用示例试试
          </button>
        </div>
        <p v-if="loadError" class="empty-error" role="alert">
          {{ loadError }}
        </p>
      </section>
    </main>

    <aside class="companion" aria-label="Hiyori 和播放控制">
      <Live2DStage :read-mouth="reader.readMouth" />

      <div class="controls">
        <div class="transport">
          <button type="button" class="icon-btn" aria-label="上一句" :disabled="!doc" @click="reader.step(-1)">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M7 5v14M19 5l-9 7 9 7z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
          </button>
          <button
            type="button"
            class="play-btn"
            :aria-label="isActive ? '暂停' : '开始朗读'"
            :disabled="!doc"
            @click="reader.toggle()"
          >
            <svg v-if="isActive" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" /><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" /></svg>
            <svg v-else viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" /></svg>
          </button>
          <button type="button" class="icon-btn" aria-label="下一句" :disabled="!doc" @click="reader.step(1)">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M17 5v14M5 5l9 7-9 7z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
          </button>
        </div>

        <div v-if="doc" class="progress">
          <div class="progress-track" aria-hidden="true">
            <span class="progress-fill" :style="{ transform: `scaleX(${progress})` }" />
          </div>
          <p class="progress-text">
            第 {{ position }} 句，共 {{ speakableTotal }} 句
          </p>
          <div class="progress-track is-prepare" aria-hidden="true">
            <span class="progress-fill" :style="{ transform: `scaleX(${speakableCount ? preparedCount / speakableCount : 0})` }" />
          </div>
          <p class="progress-text" :class="{ 'is-error': synthError }">
            {{ prepareText }}
          </p>
        </div>

        <p class="status" :class="{ 'is-error': status === 'error' }" role="status" aria-live="polite">
          {{ statusText }}
          <button v-if="status === 'error'" type="button" class="link-btn" @click="settingsOpen = true">
            检查朗读设置
          </button>
        </p>
      </div>
    </aside>

    <SettingsDialog
      v-model:open="settingsOpen"
      :settings="settings"
      :prompt-file-name="promptFile?.name ?? null"
      :status="statusText"
      :busy="status === 'loading'"
      @upload-prompt="onUploadPrompt"
      @reset-prompt="onResetPrompt"
      @preview="reader.preview(PREVIEW_TEXT)"
    />

    <div v-if="dragging" class="drop-hint" aria-hidden="true">
      <p>松开鼠标，打开这份文档</p>
    </div>
  </div>
</template>
