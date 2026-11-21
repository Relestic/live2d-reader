# Hiyori 朗读器

打开一份 Word 文档（.docx），Live2D 角色 Hiyori 用 CosyVoice 合成的声音一句一句读出来。读到哪句，荧光笔就随着声音划过哪句，Hiyori 的嘴型跟着音频动。点任意一句可以从那里开始读。

用到的东西：

- **嘴型**：[moeru-ai/airi](https://github.com/moeru-ai/airi) 的 [model-driver-lipsync](https://github.com/moeru-ai/airi/tree/main/packages/model-driver-lipsync)。它是 airi 仓库里的私有包，npm 上装不到，所以源码复制在 `src/lipsync/`（MIT 协议，原文件和许可证都保留了）。它底下用的是 npm 上的 [wlipsync](https://www.npmjs.com/package/wlipsync)。
- **声音**：[CosyVoice](https://github.com/QwenAudio/CosyVoice) 的 FastAPI 接口，由本项目 `cosyvoice/server.py` 提供兼容新版的服务。
- **角色**：[CubismWebSamples 里的 Hiyori](https://github.com/Live2D/CubismWebSamples/tree/develop/Samples/Resources/Hiyori)，用 airi 同款的 pixi.js 6 + pixi-live2d-display 渲染，Cubism Core 用 airi 的 `@proj-airi/unplugin-live2d-sdk` 自动下载。
- **文档**：[mammoth](https://github.com/mwilliamson/mammoth.js) 把 .docx 转成 HTML，保留标题、列表、表格、加粗和图片。

## 一键启动（Windows + WSL2）

CosyVoice 装在 WSL2 的 `~/CosyVoice`、conda 环境叫 `cosyvoice` 的话，双击 `start.bat` 就行。它会开两个窗口，一个跑 CosyVoice，一个跑阅读器，然后自动打开浏览器。第一次启动 CosyVoice 要加载模型，等它的窗口出现 `Uvicorn running` 再按播放。

`start.bat` 用的是本项目 `cosyvoice/server.py`，它是官方 server.py 的修正版：新版 CosyVoice 要求参考音频传文件路径，官方 server.py 还在传读好的音频，零样本合成每次都会报 `TypeError: Invalid file: tensor(...)`。修正版还让请求一个一个排队合成。

## 1. 启动 CosyVoice 服务

按 CosyVoice 官方 README 装好环境、下载模型，然后启动 FastAPI 服务。建议用本项目里的修正版 server.py（见上一节）：

```sh
cd live2d-reader/cosyvoice
python server.py --port 50000 --model_dir iic/CosyVoice2-0.5B
```

- `--model_dir` 也可以直接写 ModelScope 的模型 ID（默认就是 `iic/CosyVoice2-0.5B`），第一次启动会自动下载。
- 换成 `Fun-CosyVoice3-0.5B` 或 `CosyVoice-300M-SFT` 也行，记得在阅读器的「朗读设置 → 模型」里选同一个。
- 启动时如果报缺少 `python-multipart`，执行 `pip install python-multipart`。
- CosyVoice 官方以 Linux 为主。在 Windows 上建议跑在 WSL2 里，Windows 的浏览器一般可以直接通过 `127.0.0.1:50000` 访问到 WSL2 里的服务。

## 2. 启动阅读器

需要 Node.js 20.19 或更新的版本。

```sh
cd live2d-reader
npm install
npm run dev
```

然后打开终端里显示的地址（默认 http://localhost:5173）。

`npm run dev` 启动前会自动做两件事：

- `scripts/fetch-assets.mjs` 从 GitHub 下载 Hiyori 模型、口型配置 `profile.json` 和 CosyVoice 自带的参考音频，放到 `public/`。已经下载过的会跳过。
- `vite.config.ts` 里的 `DownloadLive2DSDK` 从 Live2D 官网下载 Cubism SDK，把 `live2dcubismcore.min.js` 放到 `public/assets/js/`。

访问 GitHub 有困难时，可以给下载脚本加一个镜像前缀，每个下载地址都会拼在它后面：

```sh
# PowerShell
$env:ASSET_PROXY_PREFIX="https://ghfast.top/"; npm run setup
```

CosyVoice 不在本机 50000 端口时，用环境变量告诉开发服务器：

```sh
# PowerShell
$env:COSYVOICE_URL="http://192.168.1.20:50000"; npm run dev
```

页面要通过 `localhost` 或 `https` 打开。口型分析用的 AudioWorklet 在「局域网 IP + http」下浏览器不给用。

## 3. 使用

- 点「打开文档」或者把 .docx 拖进窗口。旧版 .doc 需要先在 Word 里另存为 .docx。
- 空格键开始和暂停，左右方向键跳到上一句、下一句，点任意一句从那里读。
- 正在读的句子先出现浅色标记，声音开始后亮黄色的荧光笔按音频时长从头划到尾。划线速度按字数平均分配，和实际语速会有一点出入。
- 手动滚动页面后，5 秒内不会自动跟随朗读位置。
- 舞台右上角可以在特写和全身之间切换。默认是特写，嘴型看得清楚。

### 朗读设置

| 设置 | 说明 |
| --- | --- |
| CosyVoice 服务地址 | 默认 `/cosyvoice`，由开发服务器转发到 CosyVoice，不用处理跨域。 |
| 模型 | 决定采样率：CosyVoice2 和 3 是 24 kHz，300M 系列是 22.05 kHz。服务返回的是不带文件头的原始 PCM，选错了声音会变尖或变粗。 |
| 音色 | 「参考音频克隆」调用 `/inference_zero_shot`，所有模型都能用；「预置音色」调用 `/inference_sft`，只有 CosyVoice-300M-SFT 有，音色 ID 例如 `中文女`。 |
| 参考音频 | 默认用 CosyVoice 自带的 `zero_shot_prompt.wav`。上传自己的录音后，要把录音里说的原话一字不差地填进下面的文本框。 |
| 嘴型幅度 | Hiyori 张嘴太小或太大时调这个。 |

「试听一句」可以先确认服务通不通。

### 排查合成一直等待

确认启动的是本项目的 `cosyvoice/server.py`，并等服务窗口出现 `Uvicorn running` 后再试听。首次启动可能需要下载文本规范化模型，期间尚不能合成。

上游合成出错或中途断开时，网页现在会立即显示错误。修复了 Vite 代理没有结束响应、导致页面一直等待的问题。

在项目目录可以运行以下检查（Windows PowerShell 使用 `npm.cmd`）：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

前两条应无报错退出，最后一条显示 `built`。具体实测结果和仍待验证的项目见 `DEBUGGING.md`。

## 嘴型是怎么做的

1. 每句的 PCM 变成 `AudioBuffer` 播放。播放节点同时接到扬声器和 wLipSync 的 AudioWorklet 节点（`createLive2DLipSync`）。
2. `getMouthOpen()` 给出张嘴程度，写进 Hiyori 的 `ParamMouthOpenY`。
3. Hiyori 没有 A/I/U/E/O 单独的嘴型参数，只有 `ParamMouthOpenY` 和 `ParamMouthForm`。所以用 airi 的 `createWLipSyncVowelDriver()` 算出元音权重，I、E 让嘴变宽，U、O 让嘴变圆，写进 `ParamMouthForm`（`src/lib/mouth.ts`）。
4. 写入发生在 pixi-live2d-display 的 `beforeModelUpdate` 事件里，在待机动作和物理计算之后，所以朗读时嘴型优先于待机动作。一句读完后，按 airi 的做法用 200 毫秒把嘴收回去，再保持闭合 500 毫秒，然后把嘴还给待机动作。

## 目录

```
scripts/fetch-assets.mjs     下载 Hiyori、profile.json、参考音频
src/App.vue                  页面布局、打开文档、键盘和拖放
src/components/
  Live2DStage.vue            pixi 舞台，加载 Hiyori，挂上嘴型写入
  ReaderPane.vue             文档显示、当前句高亮和荧光笔动画、自动滚动
  SettingsDialog.vue         朗读设置
src/composables/useReadAloud.ts  朗读队列：按顺序合成、预取后两句、暂停、跳句
src/lib/
  docx.ts                    mammoth 转 HTML，按句包上 <span data-s>
  segment.ts                 中英文分句
  cosyvoice.ts               CosyVoice FastAPI 客户端
  mouth.ts                   元音到 ParamMouthForm 的映射，写入模型
src/lipsync/                 airi model-driver-lipsync 的副本（MIT）
```

## 许可

- `src/lipsync/` 里的代码来自 airi，MIT 协议，见 `src/lipsync/LICENSE`。
- Hiyori 模型适用 Live2D 的 Free Material License，Cubism Core 适用 Live2D Proprietary Software License。公开发布或商用前请先看 Live2D 官网的条款。
- CosyVoice 是 Apache-2.0 协议。
