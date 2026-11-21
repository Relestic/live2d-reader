<script setup lang="ts">
import type { TtsSettings } from '../lib/cosyvoice'

import { onMounted, ref, watch } from 'vue'

import { modelOptions } from '../lib/cosyvoice'

const props = defineProps<{
  /** Edited in place; the parent saves it. */
  settings: TtsSettings
  promptFileName: string | null
  status: string
  busy: boolean
}>()

const emit = defineEmits<{
  uploadPrompt: [file: File]
  resetPrompt: []
  preview: []
}>()

const open = defineModel<boolean>('open', { required: true })
const dialog = ref<HTMLDialogElement>()

function sync(value: boolean) {
  const element = dialog.value
  if (!element)
    return
  if (value && !element.open)
    element.showModal()
  else if (!value && element.open)
    element.close()
}

watch(open, sync)
onMounted(() => sync(open.value))

function onPromptFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file)
    emit('uploadPrompt', file)
  input.value = ''
}
</script>

<template>
  <dialog ref="dialog" class="settings" aria-labelledby="settings-title" @close="open = false">
    <form class="settings-body" @submit.prevent="open = false">
      <header class="settings-head">
        <h2 id="settings-title">
          朗读设置
        </h2>
        <button type="button" class="icon-close" aria-label="关闭朗读设置" @click="open = false">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
      </header>

      <label class="field">
        <span class="field-label">CosyVoice 服务地址</span>
        <input v-model.lazy.trim="props.settings.baseUrl" type="text" spellcheck="false" autocomplete="off">
        <small>默认的 /cosyvoice 由开发服务器转发到 http://127.0.0.1:50000，可以在启动前设置环境变量 COSYVOICE_URL 改。也可以直接填完整地址，比如 http://192.168.1.20:50000。</small>
      </label>

      <label class="field">
        <span class="field-label">模型</span>
        <select v-model="props.settings.model">
          <option v-for="option in modelOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <small>选和 server.py 的 --model_dir 一样的模型。选错的话，声音会变尖或变粗。</small>
      </label>

      <fieldset class="field">
        <legend class="field-label">音色</legend>
        <label class="choice">
          <input v-model="props.settings.mode" type="radio" value="zero_shot">
          用参考音频克隆音色
        </label>
        <label class="choice">
          <input v-model="props.settings.mode" type="radio" value="sft">
          用预置音色（只有 CosyVoice-300M-SFT 有）
        </label>
      </fieldset>

      <template v-if="props.settings.mode === 'zero_shot'">
        <div class="field">
          <span class="field-label">参考音频</span>
          <p class="prompt-file">
            {{ promptFileName ?? 'CosyVoice 自带的 zero_shot_prompt.wav' }}
          </p>
          <div class="field-actions">
            <label class="btn">
              上传音频
              <input type="file" accept="audio/*,.wav" class="visually-hidden" @change="onPromptFile">
            </label>
            <button v-if="promptFileName" type="button" class="btn" @click="emit('resetPrompt')">
              换回自带的
            </button>
          </div>
          <small>3 到 10 秒、只有一个人说话、没有背景音乐的录音效果最好。上传的音频只在这次打开页面时有效。</small>
        </div>

        <label class="field">
          <span class="field-label">参考音频里说的话</span>
          <textarea v-model.lazy="props.settings.promptText" rows="2" placeholder="一字不差地写下参考音频里说的原话" />
          <small v-if="props.settings.model === 'cosyvoice3'">CosyVoice3 需要的 “You are a helpful assistant.&lt;|endofprompt|&gt;” 前缀会自动加上。</small>
        </label>
      </template>

      <label v-else class="field">
        <span class="field-label">音色 ID</span>
        <input v-model.lazy.trim="props.settings.spkId" type="text" spellcheck="false">
        <small>例如 中文女、中文男、英文女、日语男。</small>
      </label>

      <label class="field">
        <span class="field-label">音量</span>
        <input v-model.number="props.settings.volume" type="range" min="0" max="1.5" step="0.05">
      </label>

      <label class="field">
        <span class="field-label">嘴型幅度</span>
        <input v-model.number="props.settings.mouthGain" type="range" min="0.4" max="2" step="0.05">
        <small>Hiyori 张嘴太小就往右拉，太大就往左拉。</small>
      </label>

      <footer class="settings-foot">
        <p class="settings-status" role="status" aria-live="polite">
          {{ status }}
        </p>
        <button type="button" class="btn" :disabled="busy" @click="emit('preview')">
          试听一句
        </button>
        <button type="submit" class="btn btn-primary">
          完成
        </button>
      </footer>
    </form>
  </dialog>
</template>
