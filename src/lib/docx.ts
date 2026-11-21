import mammoth from 'mammoth/mammoth.browser.js'

import { ReaderError } from './errors'
import { splitSentences } from './segment'

export interface Sentence {
  index: number
  text: string
  /** False for sentences made only of punctuation or symbols. They are shown but not sent to the TTS. */
  speakable: boolean
}

export interface ReadableDocument {
  /** The document as HTML, with every sentence wrapped in `<span data-s="index">`. */
  html: string
  sentences: Sentence[]
}

// Text is grouped by its closest block, so a sentence never crosses a paragraph, list item or table cell.
const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,caption,dt,dd,figcaption,pre'
const SPEAKABLE = /[\p{L}\p{N}]/u

export async function readDocx(file: File): Promise<ReadableDocument> {
  if (!/\.docx$/i.test(file.name)) {
    throw new ReaderError(/\.doc$/i.test(file.name)
      ? '旧版 .doc 格式读不了。请在 Word 里把它另存为 .docx 再打开。'
      : `只能打开 Word 的 .docx 文件，「${file.name}」不是。`)
  }

  let html: string
  try {
    // A style map embedded in the file could produce arbitrary tag names, so it is ignored.
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, { includeEmbeddedStyleMap: false })
    html = result.value
  }
  catch (error) {
    console.error(error)
    throw new ReaderError(`「${file.name}」打不开，文件可能损坏了，或者设置了密码。`)
  }

  return segmentHtml(html)
}

/** Wraps each sentence of the HTML in a span. Inline formatting such as bold and links is kept. */
export function segmentHtml(html: string): ReadableDocument {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const root = doc.body
  sanitize(root)
  // mammoth turns soft line breaks into <br>. A newline keeps the lines apart and also ends the sentence.
  root.querySelectorAll('br').forEach(br => br.before(doc.createTextNode('\n')))

  const groups = new Map<Element, Text[]>()
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    if (!text.data)
      continue
    const block = text.parentElement?.closest(BLOCK_SELECTOR) ?? root
    const list = groups.get(block)
    if (list)
      list.push(text)
    else
      groups.set(block, [text])
  }

  const sentences: Sentence[] = []
  for (const nodes of groups.values())
    wrapSentences(doc, nodes, sentences)

  if (!sentences.some(sentence => sentence.speakable))
    throw new ReaderError('这份文档里没有可以朗读的文字。')

  return { html: root.innerHTML, sentences }
}

function wrapSentences(doc: Document, nodes: Text[], sentences: Sentence[]) {
  const full = nodes.map(node => node.data).join('')
  const ranges = splitSentences(full)
  if (!ranges.length)
    return

  const base = sentences.length
  ranges.forEach((range, offset) => {
    const text = full.slice(range.start, range.end).replace(/\s+/g, ' ')
    sentences.push({ index: base + offset, text, speakable: SPEAKABLE.test(text) })
  })

  // A sentence may run across several text nodes (for example a bold word in the middle),
  // so each text node is cut at the sentence edges and every piece gets its own span.
  let nodeStart = 0
  for (const node of nodes) {
    const nodeEnd = nodeStart + node.data.length
    const fragment = doc.createDocumentFragment()
    let cursor = nodeStart
    let pieces = 0

    for (let offset = 0; offset < ranges.length; offset += 1) {
      const start = Math.max(ranges[offset].start, nodeStart)
      const end = Math.min(ranges[offset].end, nodeEnd)
      if (start >= end)
        continue
      if (start > cursor)
        fragment.append(full.slice(cursor, start))
      const span = doc.createElement('span')
      span.dataset.s = String(base + offset)
      span.textContent = full.slice(start, end)
      fragment.append(span)
      cursor = end
      pieces += 1
    }

    if (pieces > 0) {
      if (cursor < nodeEnd)
        fragment.append(full.slice(cursor, nodeEnd))
      node.replaceWith(fragment)
    }
    nodeStart = nodeEnd
  }
}

/** The HTML comes from a file the reader picked, so scripts, event handlers and unsafe links are removed. */
function sanitize(root: HTMLElement) {
  root.querySelectorAll('script,style,iframe,object,embed,link,meta,form,noscript,template,svg,math,base,noembed,noframes,xmp').forEach(element => element.remove())

  root.querySelectorAll('*').forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const isImageSource = element.tagName === 'IMG' && name === 'src'
      if (name.startsWith('on'))
        element.removeAttribute(attribute.name)
      else if ((name === 'href' || name === 'src') && !isSafeUrl(attribute.value, isImageSource))
        element.removeAttribute(attribute.name)
    }

    if (element.tagName === 'A' && element.getAttribute('href')?.match(/^https?:/i)) {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    }
  })
}

function isSafeUrl(value: string, allowImageData: boolean) {
  const url = value.trim().toLowerCase()
  if (allowImageData && url.startsWith('data:image/'))
    return true
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('mailto:') || url.startsWith('#')
}
