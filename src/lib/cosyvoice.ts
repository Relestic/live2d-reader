// Client for the compatible CosyVoice FastAPI server in cosyvoice/server.py.
// The server streams raw 16-bit mono PCM without a header, so the sample rate comes from the model choice.

import { ReaderError } from './errors'

export type CosyVoiceModel = 'cosyvoice2' | 'cosyvoice3' | 'cosyvoice1'
export type VoiceMode = 'zero_shot' | 'sft'

export interface TtsSettings {
  /** `/cosyvoice` goes through the Vite proxy; a full URL talks to the server directly. */
  baseUrl: string
  model: CosyVoiceModel
  mode: VoiceMode
  /** What is said in the reference audio (zero_shot). */
  promptText: string
  /** Built-in speaker of CosyVoice-300M-SFT (sft). */
  spkId: string
  volume: number
  mouthGain: number
}

export const DEFAULT_PROMPT_TEXT = '希望你以后能够做的比我还好呦。'

export const defaultSettings: TtsSettings = {
  baseUrl: '/cosyvoice',
  model: 'cosyvoice2',
  mode: 'zero_shot',
  promptText: DEFAULT_PROMPT_TEXT,
  spkId: '中文女',
  volume: 1,
  mouthGain: 1,
}

export const modelOptions: { value: CosyVoiceModel, label: string }[] = [
  { value: 'cosyvoice2', label: 'CosyVoice2-0.5B（24 kHz）' },
  { value: 'cosyvoice3', label: 'Fun-CosyVoice3-0.5B（24 kHz）' },
  { value: 'cosyvoice1', label: 'CosyVoice-300M 系列（22.05 kHz）' },
]

export function sampleRateOf(model: CosyVoiceModel) {
  return model === 'cosyvoice1' ? 22050 : 24000
}

// Fun-CosyVoice3 expects the prompt text to start with a system prompt, as in the official example.py.
const COSYVOICE3_SYSTEM_PROMPT = 'You are a helpful assistant.<|endofprompt|>'

export function promptTextFor(settings: TtsSettings) {
  const text = settings.promptText.trim()
  if (settings.model === 'cosyvoice3' && !text.includes('<|endofprompt|>'))
    return COSYVOICE3_SYSTEM_PROMPT + text
  return text
}

const SYNTH_TIMEOUT_MS = 120_000

export function endpointUrl(baseUrl: string, path: string) {
  return `${baseUrl.trim().replace(/\/+$/, '')}${path}`
}

/** Synthesizes one sentence and returns its PCM samples. */
export async function synthesize(
  text: string,
  settings: TtsSettings,
  promptWav: Blob | null,
  signal: AbortSignal,
): Promise<Int16Array> {
  const form = new FormData()
  form.append('tts_text', text)

  let path: string
  if (settings.mode === 'sft') {
    if (!settings.spkId.trim())
      throw new ReaderError('请在朗读设置里填写音色 ID。')
    path = '/inference_sft'
    form.append('spk_id', settings.spkId.trim())
  }
  else {
    if (!promptWav)
      throw new ReaderError('没有参考音频。请在朗读设置里选一段参考音频。')
    if (!settings.promptText.trim())
      throw new ReaderError('请在朗读设置里填写参考音频里说的原话。')
    path = '/inference_zero_shot'
    form.append('prompt_text', promptTextFor(settings))
    form.append('prompt_wav', promptWav, 'prompt.wav')
  }

  const url = endpointUrl(settings.baseUrl, path)
  // On a GPU one sentence takes seconds. Minutes without an answer means the server is stuck.
  const timeout = AbortSignal.timeout(SYNTH_TIMEOUT_MS)
  const timedOut = () => new ReaderError(`CosyVoice ${SYNTH_TIMEOUT_MS / 1000} 秒都没合成完一句。服务可能卡住了：在 server.py 的窗口按 Ctrl+C，重新启动它，再按播放。`)
  let response: Response
  try {
    response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.any([signal, timeout]) })
  }
  catch (error) {
    if (signal.aborted)
      throw error
    if (timeout.aborted)
      throw timedOut()
    throw new ReaderError(`连不上 CosyVoice 服务（${url}）。请确认本项目的 cosyvoice/server.py 已经启动，端口和朗读设置里的一致。`)
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).trim().slice(0, 160)
    throw new ReaderError(`CosyVoice 返回了 ${response.status}${detail ? `（${detail}）` : ''}。服务没启动、音色 ID 不存在、模型和音色方式不匹配都会这样，请看 server.py 的终端输出。`)
  }

  let bytes: ArrayBuffer
  try {
    bytes = await response.arrayBuffer()
  }
  catch (error) {
    if (signal.aborted)
      throw error
    if (timeout.aborted)
      throw timedOut()
    throw new ReaderError('CosyVoice 合成到一半断开了，请看 server.py 的终端输出。')
  }

  if (bytes.byteLength < 2)
    throw new ReaderError('CosyVoice 返回了空音频，请看 server.py 的终端输出。')

  return new Int16Array(bytes, 0, bytes.byteLength >> 1)
}

/** Needs no AudioContext, so sentences can be prepared before the reader first presses play. */
export function pcmToAudioBuffer(pcm: Int16Array, sampleRate: number) {
  const buffer = new AudioBuffer({ length: Math.max(1, pcm.length), sampleRate, numberOfChannels: 1 })
  const channel = buffer.getChannelData(0)
  for (let index = 0; index < pcm.length; index += 1)
    channel[index] = pcm[index] / 32768
  return buffer
}
