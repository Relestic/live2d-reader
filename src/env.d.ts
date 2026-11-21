/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent<object, object, any>
  export default component
}

// mammoth 的浏览器打包版本（UMD，自带 jszip），包里没有给这个入口写类型
declare module 'mammoth/mammoth.browser.js' {
  interface MammothMessage {
    type: string
    message: string
  }

  interface MammothResult {
    value: string
    messages: MammothMessage[]
  }

  const mammoth: {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }, options?: Record<string, unknown>) => Promise<MammothResult>
  }
  export default mammoth
}
