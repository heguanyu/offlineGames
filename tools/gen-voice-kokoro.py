#!/usr/bin/env python3
"""Generate the mahjong + doudizhu voice clips with Kokoro-82M-v1.1-zh (OSS, Apache-2.0) on the GPU.

Pulls the phrase manifest from gen-voice-oss.py (single source of truth) and renders each slug in the
chosen Kokoro voice, trimmed to 24 kHz mono PCM WAV (same format as the runtime expects).

  set HF_HOME=...\\tools\\models\\hf   (keeps the model out of git/deploy)
  python tools/gen-voice-kokoro.py            # all
  python tools/gen-voice-kokoro.py doudizhu   # one game

Voices (user-picked from the audition sheet):
  mahjong by wind: 0东=zm_045 young man, 1南=zf_070 young woman, 2西=zm_066 mature man, 3北=zf_051 mature woman
  doudizhu 你/下家/上家: zm_045 / zf_070 / zm_066
"""
import importlib.util
import os
import subprocess
import warnings

warnings.filterwarnings("ignore")
import numpy as np
import soundfile as sf
from kokoro import KPipeline

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m", os.path.join(HERE, "gen-voice-oss.py"))
M = importlib.util.module_from_spec(spec); spec.loader.exec_module(M)

VOICES = {
    "mahjong":  {0: "zm_045", 1: "zf_070", 2: "zm_066", 3: "zf_051"},  # 东 南 西 北
    "doudizhu": {0: "zm_045", 1: "zf_070", 2: "zm_066"},               # 你 下家 上家
}
DIRS = {"mahjong": "mahjong-tianjin", "doudizhu": "doudizhu"}
VOCAB = {"mahjong": M.VOCAB_MAHJONG, "doudizhu": M.VOCAB_DOUDIZHU}
GAMES_ROOT = os.path.normpath(os.path.join(HERE, "..", "games"))

_SR = "silenceremove=start_periods=1:start_silence=0:start_threshold=-38dB:detection=peak"
TRIM = f"{_SR},areverse,{_SR},areverse"

PIPE = KPipeline(lang_code="z", repo_id="hexgrad/Kokoro-82M-v1.1-zh")


def synth(text, voice, out_wav):
    segs = list(PIPE(text, voice=voice))
    audio = np.concatenate([s.audio.numpy() for s in segs])
    raw = out_wav + ".raw.wav"
    sf.write(raw, audio, 24000)
    subprocess.run(["ffmpeg", "-y", "-i", raw, "-af", TRIM, "-ar", "24000", "-ac", "1",
                    "-c:a", "pcm_s16le", out_wav], check=True, capture_output=True)
    os.remove(raw)


def main():
    import sys
    games = [a for a in sys.argv[1:] if a in VOCAB] or list(VOCAB)
    for game in games:
        for persona, voice in VOICES[game].items():
            d = os.path.join(GAMES_ROOT, DIRS[game], "voice", str(persona))
            os.makedirs(d, exist_ok=True)
            for slug, text in VOCAB[game].items():
                synth(text, voice, os.path.join(d, slug + ".wav"))
            print(f"{game} persona {persona} ({voice}): {len(VOCAB[game])} clips")
    print("done.")


if __name__ == "__main__":
    main()
