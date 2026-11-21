import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer as createViteServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('CosyVoice proxy finishes requests when synthesis disconnects', async (t) => {
  const upstream = createHttpServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      ...(request.url === '/fixed-empty' ? { 'Content-Length': '100000', Connection: 'keep-alive' } : {}),
      ...(request.url === '/encoded-empty' ? { 'Content-Encoding': 'gzip' } : {}),
    })
    if (request.url === '/ok') {
      response.end(Buffer.from([1, 0, 2, 0]))
      return
    }
    response.flushHeaders()
    if (!['/empty', '/fixed-empty', '/encoded-empty'].includes(request.url))
      response.write(Buffer.from([1, 0]))
    setTimeout(() => response.destroy(), 30)
  })
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const originalTarget = process.env.COSYVOICE_URL
  let vite
  t.after(async () => {
    try {
      vite?.httpServer?.closeAllConnections()
      upstream.closeAllConnections()
      await Promise.all([
        vite?.close(),
        new Promise(resolve => upstream.close(resolve)),
      ])
    }
    finally {
      if (originalTarget === undefined)
        delete process.env.COSYVOICE_URL
      else
        process.env.COSYVOICE_URL = originalTarget
    }
  })
  process.env.COSYVOICE_URL = `http://127.0.0.1:${upstream.address().port}`
  vite = await createViteServer({
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await vite.listen()
  const base = `http://127.0.0.1:${vite.httpServer.address().port}/cosyvoice`

  await t.test('normal PCM is forwarded unchanged', async () => {
    const response = await fetch(`${base}/ok`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 0, 2, 0])
  })

  await t.test('a truncated stream fails promptly instead of waiting for timeout', async () => {
    await assert.rejects(async () => {
      const response = await fetch(`${base}/truncated`, { signal: AbortSignal.timeout(2000) })
      await response.arrayBuffer()
    }, (error) => {
      assert.notEqual(error.name, 'TimeoutError', 'the proxy left the browser waiting after the upstream disconnected')
      return true
    })
  })

  await t.test('a failure before the first audio bytes returns a gateway error', async () => {
    const response = await fetch(`${base}/empty`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 502)
    assert.match(await response.text(), /CosyVoice/)
  })

  await t.test('a gateway error does not inherit the upstream audio body length', async () => {
    const response = await fetch(`${base}/fixed-empty`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 502)
    assert.match(await response.text(), /CosyVoice/)
  })

  await t.test('a gateway error does not inherit the upstream audio encoding', async () => {
    const response = await fetch(`${base}/encoded-empty`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 502)
    assert.match(await response.text(), /CosyVoice/)
  })
})
