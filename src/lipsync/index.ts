// 这个目录是 airi 的 @proj-airi/model-driver-lipsync 的本地副本。
// 原包是 airi monorepo 里的私有包（"private": true），npm 上装不到，所以把源码复制过来。
// live2d.ts、vowel-driver.ts 与原文件一致；profile.json 由 scripts/fetch-assets.mjs 从原包下载到 public/lipsync/。

import type { Profile } from 'wlipsync'

import { ReaderError } from '../lib/errors'

export * from './live2d'
export * from './vowel-driver'
export type { Profile } from 'wlipsync'

export async function loadWLipSyncProfile(url = `${import.meta.env.BASE_URL}lipsync/profile.json`): Promise<Profile> {
  const response = await fetch(url)
  // Vite answers a missing file with index.html and status 200, hence the content-type check.
  if (!response.ok || response.headers.get('content-type')?.includes('text/html'))
    throw new ReaderError('口型配置 lipsync/profile.json 没找到。先运行 npm run setup 下载素材。')
  return response.json() as Promise<Profile>
}
