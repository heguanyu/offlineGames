#!/usr/bin/env python3
"""Generate the mahjong + doudizhu voice clips with a CHINESE open-source TTS model (run on YOUR GPU).

WHY THIS SCRIPT: the runtime is fully offline either way (clips are pre-rendered + bundled in sw.js);
this only decides clip QUALITY. edge-tts (tools/gen-voice.py) is native-Mandarin but generic-announcer.
For a "voice actor" feel, generate with a Chinese OSS model — GPT-SoVITS or CosyVoice2 — on a GPU box.

WHAT YOU DO:
  1. Stand up your model (see `synth()` below — wire CosyVoice2 or GPT-SoVITS there).
  2. For each PERSONA, point it at a short reference clip (3–10 s) of the target voice — the four
     personas are: young-happy man (25) / young-happy woman (25) / mature man (45) / mature woman (45).
  3. Run:  python tools/gen-voice-oss.py                # all games, all personas
           python tools/gen-voice-oss.py mahjong       # one game
           python tools/gen-voice-oss.py doudizhu p3 tri2   # specific game + slugs
  4. It writes WAVs to games/<game>/voice/<personaIndex>/<slug>.wav (24 kHz mono, silence-trimmed).
  5. Tell me they're in — I'll wire the runtime (mahjong clip layer + doudizhu preset speakMove),
     add them to sw.js, and deploy. (Until then the games keep using their current voices.)

SEAT -> PERSONA:
  Mahjong (4 voices): assigned BY WIND, so 东 is always the young man.
      persona 0 = 东 young-happy man (25)
      persona 1 = 南 young-happy woman (25)
      persona 2 = 西 mature man (45)
      persona 3 = 北 mature woman (45)
    (runtime picks the folder with game.seatWind(seat), 0..3 = 东南西北)
  Doudizhu (3 voices): persona per seat — 你=young man, 下家=young woman, 上家=mature man.
    Change DOUDIZHU_SEAT_PERSONA below if you want different casting.
"""
import asyncio
import os
import subprocess
import sys

# ---- personas: index -> human description + your reference-audio path (for zero-shot cloning) -------
PERSONAS = {
    0: {"name": "young man (25, happy/bright)",   "ref": "refs/young_man.wav"},
    1: {"name": "young woman (25, happy/bright)", "ref": "refs/young_woman.wav"},
    2: {"name": "mature man (45, calm/steady)",   "ref": "refs/mature_man.wav"},
    3: {"name": "mature woman (45, calm/warm)",   "ref": "refs/mature_woman.wav"},
}
DOUDIZHU_SEAT_PERSONA = [0, 1, 2]   # doudizhu seats 你/下家/上家 -> persona indices (3 voices)

ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "games"))

# ---- vocab: slug -> text to synthesize -------------------------------------------------------------
# MAHJONG — runtime maps tile id -> slug: 万 ids 0..8 = m1..m9, 筒 9..17 = p1..p9, 条 18..26 = s1..s9,
# winds 27..30 = w0..w3 (东南西北), dragons 31..33 = d0..d2 (中發白); plus the call words.
# Calls: 碰; 杠 split into 明杠/暗杠/金杠 (the runtime picks by kong type). Win lines: 胡啦 (天津 self-draw),
# and 点炮 / 自摸 (国标 — won off a discard / self-drawn).
VOCAB_MAHJONG = {
    **{f"m{i}": f"{'一二三四五六七八九'[i-1]}万" for i in range(1, 10)},
    **{f"p{i}": f"{'一二三四五六七八九'[i-1]}筒" for i in range(1, 10)},
    **{f"s{i}": f"{'一二三四五六七八九'[i-1]}条" for i in range(1, 10)},
    "w0": "东", "w1": "南", "w2": "西", "w3": "北",
    "d0": "中", "d1": "發", "d2": "白",
    "pung": "碰！", "mingkong": "明杠！", "ankong": "暗杠！", "jinkong": "金杠！",
    "hula": "胡啦！", "dianpao": "点炮！", "zimo": "自摸！",
}

# DOUDIZHU — singles use the rank clips (rN); a plain trio is still 仨+rN; pairs + trio-with are now
# PRESET single clips (no concatenation). 圈 = quān (a circle), NOT juàn — verify your model says quān.
_RANKS = {"r3": "三", "r4": "四", "r5": "五", "r6": "六", "r7": "七", "r8": "八",
          "r9": "九", "r10": "十", "rJ": "勾", "rQ": "圈", "rK": "K", "rA": "尖", "r2": "二"}
VOCAB_DOUDIZHU = {
    **_RANKS,
    "sa": "仨",                                                   # plain trio: 仨 + rN
    **{f"dui{lbl}": f"对儿{txt}" for lbl, txt in                  # PRESET pairs (was 对 + rN)
       zip(["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2"], _RANKS.values())},
    "tri1": "三带一",                                             # was 仨A带B
    "tri2": "三带二",                                             # was 仨A带俩B
    "chuan": "串", "plane": "飞机", "bomb": "炸弹", "rocket": "王炸", "four2": "四带二",
    "jokerS": "小王", "jokerB": "大王",
    "bid1": "1分", "bid2": "2分", "bid3": "3分", "guo": "过", "landlord": "我是地主",
}

GAMES = {
    "mahjong": {"dir": "mahjong-tianjin", "vocab": VOCAB_MAHJONG, "personas": [0, 1, 2, 3]},
    "doudizhu": {"dir": "doudizhu", "vocab": VOCAB_DOUDIZHU, "personas": DOUDIZHU_SEAT_PERSONA},
}

# edge-tts pads silence; trim leading+trailing and force 24 kHz mono PCM WAV (gapless, no codec delay).
_SR = "silenceremove=start_periods=1:start_silence=0:start_threshold=-38dB:detection=peak"
TRIM = f"{_SR},areverse,{_SR},areverse"


def post_process(src, dst):
    """Trim silence + normalize to the runtime's format (24 kHz mono 16-bit WAV)."""
    subprocess.run(["ffmpeg", "-y", "-i", src, "-af", TRIM, "-ar", "24000", "-ac", "1",
                    "-c:a", "pcm_s16le", dst], check=True, capture_output=True)


def synth(text, persona, out_wav):
    """SYNTHESIZE `text` in `persona`'s voice, writing a WAV to `out_wav`.

    >>> WIRE YOUR MODEL HERE. <<<  Two common choices:

    # --- CosyVoice2 (zero-shot from a reference clip) ---
    #   from cosyvoice.cli.cosyvoice import CosyVoice2
    #   import torchaudio
    #   global _cv
    #   if '_cv' not in globals(): _cv = CosyVoice2('pretrained_models/CosyVoice2-0.5B')
    #   ref = PERSONAS[persona]['ref']
    #   prompt_speech = load_wav(ref, 16000)
    #   for out in _cv.inference_zero_shot(text, '<transcript of the ref clip>', prompt_speech):
    #       torchaudio.save(out_wav + '.raw.wav', out['tts_speech'], _cv.sample_rate)
    #   post_process(out_wav + '.raw.wav', out_wav); os.remove(out_wav + '.raw.wav'); return

    # --- GPT-SoVITS (via its API server, started with one model per persona, or set_ref per call) ---
    #   import requests
    #   r = requests.get('http://127.0.0.1:9880/tts', params={
    #       'text': text, 'text_lang': 'zh',
    #       'ref_audio_path': PERSONAS[persona]['ref'], 'prompt_lang': 'zh',
    #       'prompt_text': '<transcript of the ref clip>'})
    #   open(out_wav + '.raw.wav', 'wb').write(r.content)
    #   post_process(out_wav + '.raw.wav', out_wav); os.remove(out_wav + '.raw.wav'); return
    """
    raise NotImplementedError(
        "Wire your TTS model in synth() — see the CosyVoice2 / GPT-SoVITS examples in the docstring.")


def gen_game(game, only_slugs):
    g = GAMES[game]
    for persona in sorted(set(g["personas"])):
        d = os.path.join(ROOT, g["dir"], "voice", str(persona))
        os.makedirs(d, exist_ok=True)
        n = 0
        for slug, text in g["vocab"].items():
            if only_slugs and slug not in only_slugs:
                continue
            synth(text, persona, os.path.join(d, slug + ".wav"))
            n += 1
        print(f"  {game} persona {persona} ({PERSONAS[persona]['name']}): wrote {n} clips")


def main():
    args = sys.argv[1:]
    games = [a for a in args if a in GAMES] or list(GAMES)
    only = set(a for a in args if a not in GAMES) or None
    for game in games:
        print(f"{game}:")
        gen_game(game, only)
    print("done.")


if __name__ == "__main__":
    main()
