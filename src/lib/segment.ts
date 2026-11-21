export interface TextRange {
  start: number
  end: number
}

const TERMINATORS = new Set(['。', '！', '？', '!', '?', '；', ';', '…', '\n'])
const CLOSERS = new Set(['”', '’', '"', '\'', '」', '』', '）', ')', ']', '】', '》', '〉'])
const SOFT_BREAKS = new Set(['，', ',', '、', '：', ':'])
const WHITESPACE = /\s/

/** Sentences longer than this are cut at a comma, so the highlight and the speech stay in step. */
const MAX_SENTENCE_LENGTH = 120

/**
 * Splits text into sentence ranges for Chinese and English.
 *
 * A sentence ends at 。！？；… (and their ASCII forms), or at a period that is followed by
 * whitespace, a closing quote or the end of the text, so "3.14" stays whole.
 * Closing quotes and brackets stay with the sentence they close.
 * The returned ranges are trimmed, and whitespace between sentences belongs to none of them.
 */
export function splitSentences(text: string): TextRange[] {
  const rough: TextRange[] = []
  let start = 0
  let index = 0

  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    const ends = TERMINATORS.has(char)
      || (char === '.' && (next === undefined || WHITESPACE.test(next) || CLOSERS.has(next)))

    if (!ends) {
      index += 1
      continue
    }

    let end = index + 1
    while (end < text.length && (TERMINATORS.has(text[end]) || CLOSERS.has(text[end]) || text[end] === '.'))
      end += 1

    rough.push({ start, end })
    start = end
    index = end
  }

  if (start < text.length)
    rough.push({ start, end: text.length })

  const sentences: TextRange[] = []
  for (const range of rough) {
    for (const part of splitLong(text, range)) {
      const trimmed = trim(text, part)
      if (trimmed)
        sentences.push(trimmed)
    }
  }
  return sentences
}

function splitLong(text: string, range: TextRange): TextRange[] {
  if (range.end - range.start <= MAX_SENTENCE_LENGTH)
    return [range]

  const parts: TextRange[] = []
  let start = range.start
  let lastBreak = -1

  for (let index = range.start; index < range.end; index += 1) {
    if (SOFT_BREAKS.has(text[index]))
      lastBreak = index + 1
    if (index + 1 - start >= MAX_SENTENCE_LENGTH && lastBreak > start) {
      parts.push({ start, end: lastBreak })
      start = lastBreak
      lastBreak = -1
    }
  }

  if (start < range.end)
    parts.push({ start, end: range.end })
  return parts
}

function trim(text: string, range: TextRange): TextRange | null {
  let { start, end } = range
  while (start < end && WHITESPACE.test(text[start]))
    start += 1
  while (end > start && WHITESPACE.test(text[end - 1]))
    end -= 1
  return start < end ? { start, end } : null
}
