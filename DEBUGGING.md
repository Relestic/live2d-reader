# Hiyori 朗读器调试交接

给接手调试的 agent。这份文档说明项目是什么、环境什么样、做过哪些事、哪些地方没验证过，以及建议按什么顺序查。

## 1. 项目是什么

`live2d-reader/` 是一个网页阅读器。用户打开 Word 文档（.docx）后，Live2D 角色 Hiyori 用 CosyVoice 合成的声音一句一句读出来，同时做口型，当前句用荧光笔高亮。

| 部分 | 用了什么 | 在哪里 |
| --- | --- | --- |
| 前端 | Vite 8 + Vue 3.5 + TypeScript 6 | `src/` |
| 角色 | pixi.js 6 + pixi-live2d-display 0.4（cubism4），模型是 CubismWebSamples 的 Hiyori | `src/components/Live2DStage.vue`，素材由 `scripts/fetch-assets.mjs` 下载到 `public/` |
| 口型 | airi 的 model-driver-lipsync，源码原样复制过来（MIT），底层是 wlipsync | `src/lipsync/`，`src/lib/mouth.ts` |
| 语音 | CosyVoice 的 FastAPI 服务，返回不带文件头的 int16 单声道 PCM，CosyVoice2 是 24 kHz | `src/lib/cosyvoice.ts`，`cosyvoice/server.py` |
| 文档 | mammoth 转 HTML，按句子包成 `<span data-s>`，并做清洗 | `src/lib/docx.ts`，`src/lib/segment.ts` |
| 朗读调度 | 后台 worker 按顺序合成全文，结果缓存到 IndexedDB | `src/composables/useReadAloud.ts`，`src/lib/audio-cache.ts` |

前端通过 Vite 代理访问 CosyVoice：浏览器请求 `/cosyvoice/*`，Vite 转发到 `http://127.0.0.1:50000`（见 `vite.config.ts`，可以用环境变量 `COSYVOICE_URL` 改）。

用户确定过的范围，不要改：只做独立网页；“跟读”指的是角色朗读加当前句高亮，不做用户录音跟读；只支持 .docx；技术栈是用户指定的。

## 2. 用户环境

- Windows 10 家庭中文版。PowerShell 禁止运行脚本，所以 npm 要写成 `npm.cmd`，或者先运行 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。
- Node 已经装好，版本没确认过，要求 20.19 以上。
- WSL2 里装的是 Ubuntu 26.04。CosyVoice 在 `~/CosyVoice`，conda 环境是 `~/miniconda3` 下的 `cosyvoice`，Python 3.10。
- 显卡 RTX 4060 Ti 16 GB。`torch 2.3.1+cu121`，`torch.cuda.is_available()` 返回 True。
- 模型 `iic/CosyVoice2-0.5B` 已经下载到 `~/.cache/modelscope/hub/iic/CosyVoice2-0.5B`。
- 用户是新手，常常把终端提示符连同输出一起粘回终端执行。给命令时请一行一行给，并说明要等什么输出。

## 3. 安装 CosyVoice 时已经解决的问题

| 现象 | 处理 |
| --- | --- |
| 在 base 环境（Python 3.14）里编译 grpcio 失败 | 改用 conda 环境 `cosyvoice`，Python 3.10 |
| `CondaToSNonInteractiveError` | 已对 pkgs/main 和 pkgs/r 执行 `conda tos accept` |
| 安装 openai-whisper 时报 `No module named 'pkg_resources'` | 先 `pip install "setuptools<70" wheel`，再用 `--no-build-isolation` 装 whisper |
| 启动时报 `CUDA_HOME does not exist`（deepspeed） | `pip uninstall -y deepspeed`，只做推理不需要它 |
| ModelScope 下载时 DNS 时好时坏 | 在 `/etc/wsl.conf` 里写 `generateResolvConf=false`，`/etc/resolv.conf` 改成 223.5.5.5 和 119.29.29.29 |

## 4. 当前的主要问题：合成一直没有结果

用户看到的现象：阅读器显示“后台合成中：0 / 10 句”“正在合成第 1 句…”，然后一直停在那里。

已经查到的原因：官方 `runtime/python/fastapi/server.py` 和用户装的新版 CosyVoice 对不上。官方 server.py 先用 `load_wav(prompt_wav.file, 16000)` 把上传的音频读成 tensor，再传给 `inference_zero_shot`。但新版的 `frontend._extract_speech_feat` 会自己调用 `load_wav(prompt_wav, 24000)`，它期望拿到的是文件路径。结果每个零样本请求都在 0.02 秒内失败。用 curl 测试时，返回 200、正文 0 字节，并提示 `transfer closed with outstanding read data`。服务端日志是 `TypeError: Invalid file: tensor([[...]])`，位置在 `soundfile.py` 的 `_open`。

已有改动（验证情况见第 5 节）：

1. `cosyvoice/server.py` 是修正版。它把上传的音频存成临时文件，把路径传给模型，用完删除；每次合成都加了 `threading.Lock`；它从 `$COSYVOICE_HOME`（默认 `~/CosyVoice`）导入 CosyVoice，并 `chdir` 到那个目录。用户 WSL 里原来的 server.py 没有改。
2. `start.bat` 用 `wsl.exe --cd <项目>\cosyvoice` 启动修正版 server.py，再在另一个窗口运行 `npm.cmd run dev`，然后打开 `http://localhost:5173`。
3. 前端合成请求加了 120 秒超时（`AbortSignal.any` + `AbortSignal.timeout`），界面上会显示“第 N 句已等 X 秒”。

本次已复现并修复的另一原因（2026-11-21）：Vite 8 的代理在上游已经返回 200、随后流中途断开时，没有结束下游响应，浏览器会一直等到 120 秒超时。`vite.config.ts` 现在监听上游 `aborted` / `error`：还没有向浏览器发送音频时返回 502，并清除原音频的长度、压缩和传输响应头；已经发送了部分音频时断开下游，让 `response.arrayBuffer()` 立即报错。`tests/proxy.test.mjs` 使用真实 Vite 配置和本地 HTTP 故障服务验证正常 PCM、部分音频断开、空音频断开、固定长度加保持连接、压缩响应头五个场景。异常场景均先复现失败，再修复通过；`npm.cmd test` 显示 6 项通过（含外层测试）。独立代码审查及修正后的复核已通过。

## 5. 本机验证结果（2026-11-21）

本次已能通过 `wsl.exe -d Ubuntu` 执行命令，并使用本机 Edge 无界面浏览器做真实端到端验证：

- `npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd test` 均通过。
- 实际运行本项目 `cosyvoice/server.py`，使用已缓存的 CosyVoice2-0.5B。直连接口返回 200、215040 字节 PCM、耗时 8.2 秒；经过 Vite 代理返回 200、253440 字节 PCM、耗时 3.2 秒（随机合成长度会变化）。
- 浏览器中“试听一句”完成，5.1 秒语音合成耗时约 3.4 秒。AudioWorklet 正常工作，采样得到的嘴型张开幅度超过 0.9，Live2D 画布正常渲染。
- 示例文本后台合成从 0 / 10 到 10 / 10；刷新后重新打开示例，10 句缓存命中，新增合成请求数为 0。
- 点击句子、高亮随播放、暂停、恢复、上一句、下一句均通过。
- 导入实际 OOXML `.docx` 测试文件，标题、加粗、项目列表、表格和句子标记均正常。尚未使用用户自己的 Word 文档验证特殊排版。
- 故意选择不匹配的预置音色，浏览器立即显示 502 错误，随后切回参考音频模式能够继续合成，没有卡在 0 / 10。浏览器没有未捕获脚本异常。
- `start.bat` 使用的带空格路径 `wsl --cd`、conda 激活及 Windows `npm.cmd run dev` 子命令均分别运行成功。尚未实际双击批处理启动整套窗口。

之后新加、还没验证的功能：视线跟随鼠标（`Live2DStage.vue` 的 `followPointer`）。它监听整个窗口的 `pointermove`，以 Hiyori 脸的位置为中心（`FACE_X`/`FACE_Y`，是按模型本地坐标 `internalModel.width/height` 估的比例）算方向，离脸越近转得越少，超过 `GAZE_REACH` 像素转到最大；鼠标离开窗口或窗口失焦时看回正前方。调用的是 `internalModel.focusController.focus(x, -y)`，模型仍是 `autoInteract: false`，所以点击不会触发动作。要验证：鼠标在左/右/上/下时头和眼睛朝对应方向转，特写和全身两种取景下中心都在脸上，朗读时口型照常。方向反了或中心偏了就调这几个常量。

本次没有改动用户 WSL 中的官方 server.py，仍应使用本项目的修正版启动。连接失败提示也已改为指向本项目 `cosyvoice/server.py`，避免误启旧版服务。

## 6. 建议的调试顺序

**第 1 步：在 WSL 里单独测试修正版服务。**

以下示例假定仓库克隆在 WSL 的 `~/live2d-reader`。如果仓库在 Windows 分区，请将 `cd` 目标替换为实际的 `/mnt/c/.../live2d-reader/cosyvoice` 路径，路径包含空格时保留双引号。

```bash
conda activate cosyvoice
cd "$HOME/live2d-reader/cosyvoice"
python server.py --port 50000 --model_dir iic/CosyVoice2-0.5B
# 在另一个窗口：
cd ~/CosyVoice
curl -sS -o /tmp/test.pcm -w "%{http_code} %{size_download}B %{time_total}s\n" -X POST http://127.0.0.1:50000/inference_zero_shot \
  -F "tts_text=你好，我是日和。接下来由我把这份文档读给你听。" -F "prompt_text=希望你以后能够做的比我还好呦。" -F "prompt_wav=@asset/zero_shot_prompt.wav"
```

预期结果是状态码 200，正文大约 150 到 250 KB，耗时几秒。如果新版 `inference_zero_shot` 的参数顺序不一样，或者 `frontend` 还有别的地方要求传 tensor，需要对照 `~/CosyVoice/cosyvoice/cli/cosyvoice.py` 和 `frontend.py` 调整。可以用 `ffmpeg -f s16le -ar 24000 -ac 1 -i /tmp/test.pcm /tmp/test.wav` 把 PCM 转成 wav 听一下。

**第 2 步：在 Windows 里检查前端。**

先在实际的 `live2d-reader` 项目目录打开 PowerShell，再逐条运行：

```powershell
npm.cmd install --registry=https://registry.npmmirror.com
npm.cmd run typecheck
npm.cmd run build
```

把类型错误都修掉。

**第 3 步：经过 Vite 代理测试。** 先运行 `npm.cmd run dev`，再在 PowerShell 里执行（要用 `curl.exe`，不能用别名 `curl`）：

```powershell
curl.exe -sS -o NUL -w "%{http_code} %{size_download}B\n" -X POST http://localhost:5173/cosyvoice/inference_zero_shot -F "tts_text=你好" -F "prompt_text=希望你以后能够做的比我还好呦。" -F "prompt_wav=@public/voice/zero_shot_prompt.wav"
```

**第 4 步：在浏览器里测试**（Chrome 或 Edge，打开 `http://localhost:5173`，按 Ctrl+F5 强制刷新）：

- 朗读设置里的「试听一句」能出声，口型会动，状态栏会显示合成耗时。
- 点「先用示例试试」后，后台进度从 0 / 10 逐句增加到 10 / 10。
- 播放时荧光笔随声音划过当前句；暂停、上一句、下一句、点击某一句开始读都正常。
- 刷新页面后再打开示例，应该显示“全文 10 句都合成好了”，播放时不再请求服务端。
- 换一个参考音频，或者改设置里的模型、音色，应该会重新合成。
- 打开一个真实的 .docx 文件，检查标题、列表、表格、加粗都正常显示，分句也正确。

**第 5 步：启动脚本。** 双击 `start.bat`，检查两个窗口都能正常启动。注意 `wsl --cd` 要能处理带空格的 Windows 项目路径；conda 的路径写死成了 `~/miniconda3`。

## 7. 可能有问题的地方

- 本次启动时，WeText 文本规范化子模型的在线下载遇到了 ModelScope 403；直接检查 API 的返回内容为“操作过于频繁，请稍后再试”。CosyVoice 捕获异常后回退为不使用额外规范化器，普通中英文合成已通过。数字、日期等规范化效果尚未验证；首次启动可能因为下载重试多等约一分钟，应以 `Uvicorn running` 为服务就绪标志。这属于外部模型下载限制，不要根据旧 SDK 的泛化认证报错反复要求用户登录。
- `server.py` 的临时文件只在生成器的 `finally` 里删除。如果客户端在生成器开始执行之前就断开了，临时文件会留在 `/tmp`。
- `useReadAloud.ts` 里，`prepare()` 每次运行都会让 `generation` 加一，并取消正在进行的请求。worker 用 `restartWorker` 重启，`audioFor` 会循环等待最新的 `keysReady`。这里在快速切换设置时最容易出现竞态。
- `audio-cache.ts` 的缓存键是对 声音 ID 加句子文本 做 SHA-256。声音 ID 包括模型、模式、promptText 和参考音频的哈希。`crypto.subtle` 只能在安全上下文中用，localhost 算安全上下文。
- 口型需要 AudioWorklet，必须用 `localhost` 或 https 打开，用局域网 IP 加 http 不行。
- CosyVoice 服务端收到请求后不会因为客户端断开而停止合成。被前端取消的请求仍然会占用模型。修正版服务端加了锁，这些请求会排队，但不会被丢掉。

## 8. 相关文件

- `cosyvoice/server.py`：修正版 CosyVoice 服务
- `start.bat`：一键启动
- `src/lib/cosyvoice.ts`：请求、超时、PCM 转换
- `src/composables/useReadAloud.ts`：合成调度和播放
- `src/lib/audio-cache.ts`：IndexedDB 缓存
- `src/App.vue`：界面和进度文字
- `README.md`：给用户看的说明
