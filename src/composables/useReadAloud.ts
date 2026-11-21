import type { Ref } from 'vue'

import type { CachedAudio } from '../lib/audio-cache'
import type { TtsSettings } from '../lib/cosyvoice'
import type { Sentence } from '../lib/docx'
import type { MouthFrame } from '../lib/mouth'
import type { Live2DLipSync, WLipSyncVowelDriver } from '../lipsync'

import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'

import { cacheAvailable, cacheKey, hashBlob, readCached, whichCached, writeCached } from '../lib/audio-cache'
import { pcmToAudioBuffer, promptTextFor, sampleRateOf, synthesize } from '../lib/cosyvoice'
import { describeError, isAbortError, ReaderError } from '../lib/errors'
import { silentMouth, vowelsToMouthForm } from '../lib/mouth'
import { createLive2DLipSync, createWLipSyncVowelDriver, loadWLipSyncProfile } from '../lipsync'

export type ReadStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'done'

/** Tells the reader pane to sweep the highlighter over a sentence while its audio plays. */
export interface SweepCue {
  index: number
  duration: number
  /** Changes on every playback, so replaying the same sentence restarts the sweep. */
  key: number
}

interface AudioRig {
  context: AudioContext
  gain: GainNode
  lipsync: Live2DLipSync
  vowels: WLipSyncVowelDriver
}

interface Waiter {
  resolve: (audio: CachedAudio) => void
  reject: (error: unknown) => void
}

/** createLive2DLipSync caps the mouth value at 0.7; this maps it back to Hiyori's 0 to 1 range. */
const LIPSYNC_CAP = 0.7
/** Decoded sentences kept in memory around the one playing. The rest stay in IndexedDB. */
const KEEP_BEHIND = 1
const KEEP_AHEAD = 4

function abortError() {
  return new DOMException('Synthesis cancelled', 'AbortError')
}

/**
 * Reads the document aloud. As soon as a document is open, a background worker synthesizes
 * every sentence in reading order, starting from the one being read, and stores the audio in
 * IndexedDB. Playback takes sentences from there, so a document read once plays at once later.
 */
export function useReadAloud(
  sentences: Readonly<Ref<Sentence[]>>,
  settings: Ref<TtsSettings>,
  getPromptWav: () => Promise<Blob | null>,
) {
  const current = ref(-1)
  const status = ref<ReadStatus>('idle')
  const message = ref('')
  const sweep = shallowRef<SweepCue | null>(null)

  /** Speakable sentences whose audio is ready. */
  const preparedCount = ref(0)
  const speakableCount = computed(() => sentences.value.filter(sentence => sentence.speakable).length)
  const synthesizing = ref(false)
  /** Why the background worker stopped, if it failed. Pressing play tries again. */
  const synthError = ref('')
  /** The sentence the server is working on now, and since when (Date.now()). */
  const workingOn = shallowRef<{ index: number, since: number } | null>(null)

  let rig: AudioRig | null = null
  let rigPromise: Promise<AudioRig> | null = null
  let source: AudioBufferSourceNode | null = null
  let paused = false
  let session = 0
  let sweepKey = 0
  let lastMouthAt = performance.now()

  // Background synthesis. `generation` changes whenever the document or the voice changes.
  let generation = 0
  let controller = new AbortController()
  let previewController = new AbortController()
  let docSentences: Sentence[] = []
  let voice: TtsSettings | null = null
  let keys: string[] = []
  let keysReady: Promise<void> = Promise.resolve()
  let useDb = true
  let focus = 0
  let workerRunning = false
  let restartWorker = false
  const done = new Set<number>()
  /** Holds the whole document's audio only when IndexedDB is unavailable. */
  const memory = new Map<number, CachedAudio>()
  const buffers = new Map<number, AudioBuffer>()
  const waiters = new Map<number, Waiter[]>()
  const promptHashes = new WeakMap<Blob, Promise<string>>()

  function ensureAudio(): Promise<AudioRig> {
    if (!rigPromise) {
      // Created synchronously, inside the click that started reading, so the browser lets it play.
      const context = new AudioContext()
      rigPromise = (async () => {
        try {
          const profile = await loadWLipSyncProfile()
          if (!context.audioWorklet)
            throw new ReaderError('口型分析需要 AudioWorklet。请用 http://localhost 或 https 打开页面，局域网 IP 加 http 不行。')
          const lipsync = await createLive2DLipSync(context, profile)
          const gain = context.createGain()
          gain.gain.value = settings.value.volume
          gain.connect(context.destination)
          rig = { context, gain, lipsync, vowels: createWLipSyncVowelDriver() }
          return rig
        }
        catch (error) {
          void context.close()
          rigPromise = null
          throw error
        }
      })()
    }
    return rigPromise
  }

  /** Identifies a voice: two sentences share cached audio only if text and voice are the same. */
  async function voiceIdOf(snapshot: TtsSettings) {
    let prompt = ''
    if (snapshot.mode === 'zero_shot') {
      const wav = await getPromptWav()
      if (wav) {
        let hash = promptHashes.get(wav)
        if (!hash) {
          hash = hashBlob(wav)
          promptHashes.set(wav, hash)
        }
        prompt = await hash
      }
    }
    return JSON.stringify([
      snapshot.model,
      snapshot.mode,
      snapshot.mode === 'zero_shot' ? promptTextFor(snapshot) : '',
      snapshot.mode === 'sft' ? snapshot.spkId.trim() : '',
      prompt,
    ])
  }

  function rejectWaiters(error: unknown) {
    for (const list of waiters.values()) {
      for (const waiter of list)
        waiter.reject(error)
    }
    waiters.clear()
  }

  /** Starts over for the current document and voice. Audio already cached is found again by its key. */
  function prepare() {
    const gen = ++generation
    controller.abort()
    controller = new AbortController()
    previewController.abort()
    rejectWaiters(abortError())
    done.clear()
    memory.clear()
    buffers.clear()
    keys = []
    voice = null
    preparedCount.value = 0
    synthError.value = ''

    const list = sentences.value
    docSentences = list
    if (!list.length) {
      keysReady = Promise.resolve()
      return
    }

    keysReady = (async () => {
      const snapshot = { ...settings.value }
      const voiceId = await voiceIdOf(snapshot)
      const nextKeys = await Promise.all(list.map(sentence => cacheKey(voiceId, sentence.text)))
      const dbOk = await cacheAvailable()
      const hits = dbOk ? await whichCached(nextKeys) : new Set<string>()
      if (gen !== generation)
        throw abortError()
      keys = nextKeys
      voice = snapshot
      useDb = dbOk
      list.forEach((sentence, index) => {
        if (sentence.speakable && hits.has(nextKeys[index]))
          done.add(index)
      })
      preparedCount.value = done.size
    })()

    keysReady.then(
      () => {
        if (gen === generation)
          void runWorker()
      },
      (error) => {
        if (gen === generation && !isAbortError(error))
          synthError.value = describeError(error)
      },
    )
  }

  function pickNext() {
    const list = docSentences
    const start = Math.min(Math.max(0, focus), list.length - 1)
    for (let step = 0; step < list.length; step += 1) {
      const index = (start + step) % list.length
      if (list[index].speakable && !done.has(index))
        return index
    }
    return -1
  }

  function inWindow(index: number) {
    const center = Math.max(0, current.value)
    return index >= center - KEEP_BEHIND && index <= center + KEEP_AHEAD
  }

  async function produce(index: number, gen: number) {
    const snapshot = voice
    if (!snapshot)
      throw abortError()
    const { signal } = controller
    const promptWav = snapshot.mode === 'zero_shot' ? await getPromptWav() : null
    // The server address may have been corrected after a failure, so it is read fresh.
    const request = { ...snapshot, baseUrl: settings.value.baseUrl }
    workingOn.value = { index, since: Date.now() }
    let pcm: Int16Array
    try {
      pcm = await synthesize(docSentences[index].text, request, promptWav, signal)
    }
    finally {
      if (workingOn.value?.index === index)
        workingOn.value = null
    }
    if (gen !== generation)
      throw abortError()

    const audio: CachedAudio = { pcm, sampleRate: sampleRateOf(snapshot.model) }
    const key = keys[index]
    if (useDb)
      await writeCached(key, audio)
    if (gen !== generation)
      throw abortError()

    // The same sentence can appear more than once in a document.
    docSentences.forEach((sentence, other) => {
      if (!sentence.speakable || keys[other] !== key)
        return
      done.add(other)
      if (!useDb)
        memory.set(other, audio)
      if (inWindow(other))
        buffers.set(other, pcmToAudioBuffer(audio.pcm, audio.sampleRate))
      const list = waiters.get(other)
      if (list) {
        waiters.delete(other)
        for (const waiter of list)
          waiter.resolve(audio)
      }
    })
    preparedCount.value = done.size
  }

  /** Synthesizes one sentence at a time until the whole document is ready. */
  async function runWorker() {
    if (workerRunning) {
      restartWorker = true
      return
    }
    // Still hashing the voice and sentences; prepare starts the worker when that is done.
    if (!voice)
      return
    workerRunning = true
    restartWorker = false
    synthesizing.value = true
    synthError.value = ''
    const gen = generation
    try {
      while (gen === generation) {
        const index = pickNext()
        if (index < 0)
          break
        await produce(index, gen)
      }
    }
    catch (error) {
      if (gen === generation && !isAbortError(error)) {
        console.error(error)
        synthError.value = describeError(error)
        rejectWaiters(error)
      }
    }
    finally {
      workerRunning = false
      synthesizing.value = false
      if (restartWorker) {
        restartWorker = false
        void runWorker()
      }
    }
  }

  /** Returns a sentence's audio, waiting for the background worker if it is not ready yet. */
  async function audioFor(index: number): Promise<AudioBuffer> {
    const hit = buffers.get(index)
    if (hit)
      return hit
    // prepare may run again while this waits, so wait until the newest keys are ready.
    for (let waited = keysReady; ; waited = keysReady) {
      await waited
      if (waited === keysReady)
        break
    }
    const gen = generation

    if (done.has(index)) {
      const audio = useDb ? await readCached(keys[index]) : memory.get(index)
      if (gen !== generation)
        throw abortError()
      if (audio) {
        const buffer = pcmToAudioBuffer(audio.pcm, audio.sampleRate)
        buffers.set(index, buffer)
        return buffer
      }
      // Removed from the cache in the meantime, for example by the browser freeing disk space.
      done.delete(index)
      preparedCount.value = done.size
    }

    const audio = await new Promise<CachedAudio>((resolve, reject) => {
      const list = waiters.get(index) ?? []
      list.push({ resolve, reject })
      waiters.set(index, list)
      void runWorker()
    })
    const buffer = buffers.get(index) ?? pcmToAudioBuffer(audio.pcm, audio.sampleRate)
    buffers.set(index, buffer)
    return buffer
  }

  function nextSpeakable(from: number, direction: 1 | -1 = 1) {
    const list = sentences.value
    for (let index = from; index >= 0 && index < list.length; index += direction) {
      if (list[index].speakable)
        return index
    }
    return -1
  }

  function evict() {
    for (const index of buffers.keys()) {
      if (!inWindow(index))
        buffers.delete(index)
    }
  }

  /** Reads the next sentence from IndexedDB while this one plays, so there is no gap. */
  function warm(index: number) {
    if (index >= 0 && done.has(index) && !buffers.has(index))
      audioFor(index).catch(() => {})
  }

  function stopSource() {
    const node = source
    source = null
    if (node) {
      try {
        node.stop()
      }
      catch {
        // Already stopped.
      }
    }
  }

  function playBuffer(audio: AudioRig, buffer: AudioBuffer): Promise<void> {
    return new Promise((resolve) => {
      const node = audio.context.createBufferSource()
      node.buffer = buffer
      node.connect(audio.gain)
      // The lip sync node has no output: it only listens, so it hears the voice before the volume control.
      audio.lipsync.connectSource(node)
      node.onended = () => {
        node.disconnect()
        if (source === node)
          source = null
        resolve()
      }
      source = node
      audio.vowels.reset()
      node.start()
    })
  }

  function fail(error: unknown) {
    console.error(error)
    status.value = 'error'
    message.value = describeError(error)
  }

  async function playFrom(start: number) {
    const first = nextSpeakable(Math.max(0, start))
    if (first < 0)
      return

    const token = ++session
    stopSource()
    paused = false
    message.value = ''
    status.value = 'loading'
    current.value = first
    focus = first
    sweep.value = null
    // After a failure, pressing play tries again.
    if (synthError.value) {
      if (voice)
        void runWorker()
      else
        prepare()
    }

    let audio: AudioRig
    try {
      audio = await ensureAudio()
      await audio.context.resume()
      // Paused while the audio was being set up.
      if (paused)
        await audio.context.suspend()
    }
    catch (error) {
      if (token === session)
        fail(error)
      return
    }

    for (let index = first; index >= 0; index = nextSpeakable(index + 1)) {
      if (token !== session)
        return
      current.value = index
      focus = index
      evict()
      if (!buffers.has(index) && !done.has(index) && !paused)
        status.value = 'loading'

      let buffer: AudioBuffer | undefined
      while (!buffer) {
        try {
          buffer = await audioFor(index)
        }
        catch (error) {
          if (token !== session)
            return
          // The voice changed while waiting: wait for the sentence in the new voice.
          if (isAbortError(error))
            continue
          fail(error)
          return
        }
      }
      if (token !== session)
        return

      warm(nextSpeakable(index + 1))
      status.value = paused ? 'paused' : 'playing'
      sweep.value = { index, duration: buffer.duration, key: ++sweepKey }
      await playBuffer(audio, buffer)
    }

    if (token === session) {
      status.value = 'done'
      current.value = -1
      sweep.value = null
    }
  }

  function pause() {
    if (status.value !== 'playing' && status.value !== 'loading')
      return
    paused = true
    status.value = 'paused'
    // Before the audio exists, playFrom and preview suspend it as soon as it is ready.
    void rig?.context.suspend()
  }

  function resume() {
    if (!paused)
      return
    paused = false
    status.value = source ? 'playing' : 'loading'
    void rig?.context.resume()
  }

  function toggle() {
    if (status.value === 'playing' || status.value === 'loading')
      pause()
    else if (status.value === 'paused')
      resume()
    else
      void playFrom(current.value >= 0 ? current.value : 0)
  }

  function step(direction: 1 | -1) {
    if (!sentences.value.length)
      return
    const from = current.value < 0 ? 0 : current.value + direction
    const index = nextSpeakable(from, direction)
    if (index >= 0)
      void playFrom(index)
  }

  /** Stops reading. Used when another document is opened; the watcher below prepares the new one. */
  function reset() {
    session += 1
    stopSource()
    paused = false
    void rig?.context.resume()
    status.value = 'idle'
    message.value = ''
    current.value = -1
    focus = 0
    sweep.value = null
  }

  /** Reads one test sentence with the current settings. It is not cached. */
  async function preview(text: string) {
    const token = ++session
    stopSource()
    previewController.abort()
    previewController = new AbortController()
    const { signal } = previewController
    paused = false
    sweep.value = null
    status.value = 'loading'
    message.value = '正在合成试听…'

    try {
      const audio = await ensureAudio()
      await audio.context.resume()
      if (paused)
        await audio.context.suspend()
      const snapshot = { ...settings.value }
      const promptWav = snapshot.mode === 'zero_shot' ? await getPromptWav() : null
      const started = performance.now()
      const pcm = await synthesize(text, snapshot, promptWav, signal)
      if (token !== session)
        return
      const buffer = pcmToAudioBuffer(pcm, sampleRateOf(snapshot.model))
      const seconds = (performance.now() - started) / 1000
      status.value = paused ? 'paused' : 'playing'
      message.value = `试听中（合成 ${buffer.duration.toFixed(1)} 秒的语音用了 ${seconds.toFixed(1)} 秒）`
      await playBuffer(audio, buffer)
      if (token === session) {
        status.value = 'idle'
        message.value = `试听完成。合成 ${buffer.duration.toFixed(1)} 秒的语音用了 ${seconds.toFixed(1)} 秒。`
      }
    }
    catch (error) {
      if (token !== session)
        return
      if (isAbortError(error)) {
        // The settings changed while the preview was being synthesized.
        status.value = 'idle'
        message.value = ''
        return
      }
      fail(error)
    }
  }

  /** Called by the Live2D stage on every frame. */
  function readMouth(): MouthFrame {
    const now = performance.now()
    const deltaSeconds = Math.min(0.1, (now - lastMouthAt) / 1000)
    lastMouthAt = now

    if (!rig || !source || paused)
      return silentMouth

    const open = Math.min(1, (rig.lipsync.getMouthOpen() / LIPSYNC_CAP) * settings.value.mouthGain)
    const vowels = rig.vowels.update(rig.lipsync.node, deltaSeconds)
    return { speaking: true, open, form: vowelsToMouthForm(vowels) }
  }

  watch(sentences, prepare, { immediate: true })

  watch(
    () => {
      const s = settings.value
      return [s.model, s.mode, s.promptText, s.spkId].join('\u0001')
    },
    prepare,
  )

  // Another server address does not change the voice; it only gives a failed worker another try.
  watch(() => settings.value.baseUrl, () => {
    if (synthError.value)
      void runWorker()
  })

  watch(() => settings.value.volume, (volume) => {
    if (rig)
      rig.gain.gain.value = volume
  })

  onScopeDispose(() => {
    session += 1
    generation += 1
    stopSource()
    controller.abort()
    previewController.abort()
    void rig?.context.close()
  })

  return {
    current,
    status,
    message,
    sweep,
    preparedCount,
    speakableCount,
    synthesizing,
    synthError,
    workingOn,
    playFrom,
    toggle,
    step,
    reset,
    preview,
    /** Call after the reference audio changed; settings changes are noticed on their own. */
    invalidateVoice: prepare,
    readMouth,
  }
}
