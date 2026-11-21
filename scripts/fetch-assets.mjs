// 下载阅读器运行需要的素材到 public/：
// - Hiyori 模型（Live2D/CubismWebSamples develop 分支）
// - wLipSync 口型配置 profile.json（moeru-ai/airi 的 model-driver-lipsync）
// - CosyVoice 自带的 zero_shot 参考音频
//
// 已存在的文件会跳过；加 --force 重新下载。
// 访问 GitHub 困难时，设置 ASSET_PROXY_PREFIX，例如 ASSET_PROXY_PREFIX=https://ghfast.top/
// 每个下载地址都会拼在这个前缀后面。

import { Buffer } from 'node:buffer'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'public')
const force = process.argv.includes('--force')
const prefix = process.env.ASSET_PROXY_PREFIX ?? ''

const HIYORI = 'https://raw.githubusercontent.com/Live2D/CubismWebSamples/develop/Samples/Resources/Hiyori/'
const hiyoriFiles = [
  'Hiyori.model3.json',
  'Hiyori.moc3',
  'Hiyori.physics3.json',
  'Hiyori.pose3.json',
  'Hiyori.userdata3.json',
  'Hiyori.cdi3.json',
  'Hiyori.2048/texture_00.png',
  'Hiyori.2048/texture_01.png',
  ...Array.from({ length: 10 }, (_, i) => `motions/Hiyori_m${String(i + 1).padStart(2, '0')}.motion3.json`),
]

const assets = [
  ...hiyoriFiles.map(file => ({ url: HIYORI + file, to: `models/Hiyori/${file}` })),
  {
    url: 'https://raw.githubusercontent.com/moeru-ai/airi/main/packages/model-driver-lipsync/src/shared/wlipsync/profile.json',
    to: 'lipsync/profile.json',
  },
  {
    url: 'https://raw.githubusercontent.com/QwenAudio/CosyVoice/main/asset/zero_shot_prompt.wav',
    to: 'voice/zero_shot_prompt.wav',
  },
]

async function exists(path) {
  try {
    return (await stat(path)).size > 0
  }
  catch {
    return false
  }
}

async function download({ url, to }) {
  const target = join(publicDir, to)
  if (!force && await exists(target))
    return false

  const response = await fetch(prefix + url, { signal: AbortSignal.timeout(180_000) })
  if (!response.ok)
    throw new Error(`HTTP ${response.status} ${response.statusText}`)

  const data = Buffer.from(await response.arrayBuffer())
  await mkdir(dirname(target), { recursive: true })
  // 先写 .part 再改名，下载中断不会留下半个文件被当成已下载
  await writeFile(`${target}.part`, data)
  await rename(`${target}.part`, target)
  return true
}

let fetched = 0
let failed = 0

for (const asset of assets) {
  try {
    if (await download(asset)) {
      fetched += 1
      console.log(`已下载 public/${asset.to}`)
    }
  }
  catch (error) {
    failed += 1
    console.error(`下载失败 public/${asset.to}：${error.message}\n  地址：${prefix + asset.url}`)
  }
}

if (failed) {
  console.error(`\n有 ${failed} 个文件没下载下来。访问 GitHub 有困难时，可以设置 ASSET_PROXY_PREFIX 走镜像后重试，或者手动把文件放到 public/ 下对应的位置。`)
  process.exit(1)
}

if (fetched)
  console.log(`素材已就绪，这次新下载了 ${fetched} 个文件。`)
