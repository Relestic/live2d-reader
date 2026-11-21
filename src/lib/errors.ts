/** An error whose message is written for the reader and can be shown as is. */
export class ReaderError extends Error {
  override name = 'ReaderError'
}

export function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function describeError(error: unknown) {
  if (error instanceof ReaderError)
    return error.message
  const detail = error instanceof Error ? error.message : String(error)
  return `出错了：${detail}`
}
