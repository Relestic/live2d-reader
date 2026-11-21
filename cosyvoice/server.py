# Fixed copy of CosyVoice's runtime/python/fastapi/server.py (Apache-2.0, Alibaba Inc, Xiang Lyu).
#
# Changes from the official file:
# - The uploaded reference audio is saved to a temporary file and its path is passed to the model.
#   Current CosyVoice loads prompt_wav itself, so the official server, which passes an already
#   loaded tensor, fails every zero-shot request with "TypeError: Invalid file: tensor(...)".
# - Only one sentence is synthesized at a time. Overlapping requests used to run on the same model
#   from several threads at once.
# - It runs from this folder and finds CosyVoice in ~/CosyVoice (or $COSYVOICE_HOME).
import argparse
import logging
import os
import shutil
import sys
import tempfile
import threading

COSYVOICE_HOME = os.path.abspath(os.path.expanduser(os.environ.get('COSYVOICE_HOME', '~/CosyVoice')))
if not os.path.isdir(os.path.join(COSYVOICE_HOME, 'cosyvoice')):
    sys.exit(f'没找到 CosyVoice：{COSYVOICE_HOME}。请设置环境变量 COSYVOICE_HOME 指向 CosyVoice 的文件夹。')
sys.path.append(COSYVOICE_HOME)
sys.path.append(os.path.join(COSYVOICE_HOME, 'third_party', 'Matcha-TTS'))
os.chdir(COSYVOICE_HOME)

logging.getLogger('matplotlib').setLevel(logging.WARNING)

import numpy as np  # noqa: E402
import uvicorn  # noqa: E402
from fastapi import FastAPI, File, Form, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import StreamingResponse  # noqa: E402

from cosyvoice.cli.cosyvoice import AutoModel  # noqa: E402

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],
    allow_credentials=True,
    allow_methods=['*'],
    allow_headers=['*'])

model_lock = threading.Lock()
cosyvoice = None


def save_upload(upload: UploadFile) -> str:
    """Writes the uploaded audio to a temporary file and returns its path."""
    suffix = os.path.splitext(upload.filename or '')[1] or '.wav'
    with tempfile.NamedTemporaryFile(prefix='cosyvoice-prompt-', suffix=suffix, delete=False) as tmp:
        shutil.copyfileobj(upload.file, tmp)
        return tmp.name


def generate_data(make_output, cleanup=None):
    """Runs one synthesis under the model lock and streams it as 16-bit mono PCM."""
    try:
        with model_lock:
            for i in make_output():
                yield (i['tts_speech'].numpy() * (2 ** 15)).astype(np.int16).tobytes()
    except Exception:
        logging.exception('合成失败')
        raise
    finally:
        if cleanup:
            try:
                os.remove(cleanup)
            except OSError:
                pass


@app.get('/inference_sft')
@app.post('/inference_sft')
async def inference_sft(tts_text: str = Form(), spk_id: str = Form()):
    return StreamingResponse(generate_data(lambda: cosyvoice.inference_sft(tts_text, spk_id)))


@app.get('/inference_zero_shot')
@app.post('/inference_zero_shot')
async def inference_zero_shot(tts_text: str = Form(), prompt_text: str = Form(), prompt_wav: UploadFile = File()):
    path = save_upload(prompt_wav)
    return StreamingResponse(generate_data(lambda: cosyvoice.inference_zero_shot(tts_text, prompt_text, path), path))


@app.get('/inference_cross_lingual')
@app.post('/inference_cross_lingual')
async def inference_cross_lingual(tts_text: str = Form(), prompt_wav: UploadFile = File()):
    path = save_upload(prompt_wav)
    return StreamingResponse(generate_data(lambda: cosyvoice.inference_cross_lingual(tts_text, path), path))


@app.get('/inference_instruct2')
@app.post('/inference_instruct2')
async def inference_instruct2(tts_text: str = Form(), instruct_text: str = Form(), prompt_wav: UploadFile = File()):
    path = save_upload(prompt_wav)
    return StreamingResponse(generate_data(lambda: cosyvoice.inference_instruct2(tts_text, instruct_text, path), path))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=50000)
    parser.add_argument('--model_dir', type=str, default='iic/CosyVoice2-0.5B',
                        help='local path or modelscope repo id')
    args = parser.parse_args()
    cosyvoice = AutoModel(model_dir=args.model_dir)
    uvicorn.run(app, host='0.0.0.0', port=args.port)
