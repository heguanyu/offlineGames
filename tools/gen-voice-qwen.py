#!/usr/bin/env python3
"""FINAL voice generation with Qwen3-TTS (on-device, GPU). Pulls the phrase manifest from
gen-voice-oss.py. Mahjong clips -> games/mahjong-common/voice/<wind 0-3>/, doudizhu -> doudizhu/voice/<seat>.

User-chosen voices:
  东/你  young man   = my2  (VoiceDesign, seed 12)
  南/下家 young woman = fy1  (Base voice-clone of the approved tools/refs/fy1_line.wav)
  西/上家 mature man  = mm1  (VoiceDesign, seed 13) + 1.8x tempo (was slow/draggy on short words)
  北     mature woman= fm1  (Base voice-clone of tools/refs/fm1_line.wav) + 1.3x tempo (+30%)

  set HF_HOME=...\\tools\\models\\hf  ;  python tools/gen-voice-qwen.py
"""
import importlib.util
import gc
import os
import subprocess
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import soundfile as sf
import torch
from qwen_tts import Qwen3TTSModel

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m", os.path.join(HERE, "gen-voice-oss.py"))
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)
ROOT = os.path.normpath(os.path.join(HERE, "..", "games"))
REFS = os.path.join(HERE, "refs")
LINE = "三万，九条。碰！自摸，胡啦！"
VOCAB = {"mahjong-common": M.VOCAB_MAHJONG, "doudizhu": M.VOCAB_DOUDIZHU}

_SR = "silenceremove=start_periods=1:start_silence=0:start_threshold=-40dB:detection=peak"
def af(atempo):
    f = f"{_SR},areverse,{_SR},areverse"
    return f + (f",atempo={atempo}" if atempo else "")

# VoiceDesign personas (seeded so every clip is the same voice)
DESIGN = {
    "my2": dict(seed=12, instruct="Male, young, warm and friendly, natural standard Mandarin, confident",
                targets=[("mahjong-common", 0), ("doudizhu", 0)], atempo=None),
    "mm1": dict(seed=13, instruct="Male, around 45 years old, deep and mellow, calm and steady, standard Mandarin",
                targets=[("mahjong-common", 2), ("doudizhu", 2)], atempo=1.8),
}
# Base voice-clone personas (reproduce the exact approved sample)
CLONE = {
    "fy1": dict(ref=os.path.join(REFS, "fy1_line.wav"), targets=[("mahjong-common", 1), ("doudizhu", 1)], atempo=None),
    "fm1": dict(ref=os.path.join(REFS, "fm1_line.wav"), targets=[("mahjong-common", 3)], atempo=1.3),
}


def save(a, sr, out, atempo):
    raw = out + ".raw.wav"; sf.write(raw, a, sr)
    subprocess.run(["ffmpeg", "-y", "-i", raw, "-af", af(atempo), "-ar", "24000", "-ac", "1",
                    "-c:a", "pcm_s16le", out], check=True, capture_output=True)
    os.remove(raw)


def run(personas, synth):
    for name, cfg in personas.items():
        for gd, seat in cfg["targets"]:
            d = os.path.join(ROOT, gd, "voice", str(seat)); os.makedirs(d, exist_ok=True)
            for slug, text in VOCAB[gd].items():
                a, sr = synth(cfg, text)
                save(np.asarray(a), sr, os.path.join(d, slug + ".wav"), cfg["atempo"])
            print(f"{name} -> {gd}/voice/{seat} ({len(VOCAB[gd])} clips)", flush=True)


def main():
    vd = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign", device_map="cuda:0",
                                       dtype=torch.bfloat16, attn_implementation="sdpa")
    def design(cfg, text):
        torch.manual_seed(cfg["seed"])
        w, sr = vd.generate_voice_design(text=text, language="Chinese", instruct=cfg["instruct"])
        return w[0], sr
    run(DESIGN, design)
    del vd; gc.collect(); torch.cuda.empty_cache()

    base = Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-1.7B-Base", device_map="cuda:0",
                                         dtype=torch.bfloat16, attn_implementation="sdpa")
    def clone(cfg, text):
        w, sr = base.generate_voice_clone(text=text, language="Chinese", ref_audio=cfg["ref"], ref_text=LINE)
        return w[0], sr
    run(CLONE, clone)
    print("ALL DONE", flush=True)


if __name__ == "__main__":
    main()
