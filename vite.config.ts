import type { ProxyOptions } from 'vite'

import { DownloadLive2DSDK } from '@proj-airi/unplugin-live2d-sdk/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  // 本项目 cosyvoice/server.py 兼容服务的地址
  const cosyvoice = env.COSYVOICE_URL || 'http://127.0.0.1:50000'

  const proxy: Record<string, ProxyOptions> = {
    '/cosyvoice': {
      target: cosyvoice,
      changeOrigin: true,
      rewrite: path => path.replace(/^\/cosyvoice/, ''),
      configure(proxy) {
        proxy.on('proxyRes', (upstream, _request, response) => {
          // http-proxy does not finish the downstream response when an upstream
          // PCM stream aborts. End it so fetch does not wait until its timeout.
          const interrupted = () => {
            if (response.writableEnded || response.destroyed)
              return
            if (!response.headersSent) {
              // These headers describe the original audio, not this error body.
              response.removeHeader('Content-Length')
              response.removeHeader('Content-Encoding')
              response.removeHeader('Transfer-Encoding')
              response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
              response.end('CosyVoice 合成连接中断，请检查服务端日志。')
            }
            else {
              response.destroy()
            }
          }
          upstream.once('aborted', interrupted)
          upstream.once('error', interrupted)
        })
      },
    },
  }

  return {
    plugins: [
      vue(),
      // 和 airi 一样：构建时下载 Cubism SDK for Web，把 live2dcubismcore.min.js 放进 public/
      DownloadLive2DSDK(),
    ],
    optimizeDeps: {
      // 舞台组件按需加载它，提前预构建，避免首次打开时 Vite 重新加载页面
      include: ['pixi-live2d-display/cubism4'],
    },
    server: { proxy },
    preview: { proxy },
  }
})
