#!/usr/bin/env python3
"""Generate the 斗地主 voice clips with edge-tts (Microsoft neural voices, free, no API key).

BUILD-TIME ONLY: this needs internet, but the ~29 short clips it writes per seat are bundled into
the PWA, so in-game playback is fully OFFLINE. The clips are ATOMS that sound.js concatenates at
runtime (仨 + 五 + 带 + 俩 + 九 = "仨五带俩九"), so the asset count is the vocabulary (~29), NOT the
number of combinations — total ~0.3-0.5 MB across all three seat voices.

  pip install edge-tts
  python tools/gen-voice.py
"""
import asyncio
import os
import subprocess
import sys

import edge_tts

# edge-tts pads each utterance with ~1s of silence; for snappy, concatenable game calls we trim
# leading + trailing silence with ffmpeg (trim front, reverse, trim front again, reverse back).
_SR = 'silenceremove=start_periods=1:start_silence=0:start_threshold=-38dB:detection=peak'
TRIM_FILTER = f'{_SR},areverse,{_SR},areverse'


def _dur(path):
    return float(subprocess.run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                                 '-of', 'default=nw=1:nk=1', path], capture_output=True, text=True).stdout.strip())


def trim_silence(src, dst):
    # output trimmed PCM WAV (24kHz mono 16-bit) — no codec/encoder-delay, so clips concatenate gaplessly
    subprocess.run(
        ['ffmpeg', '-y', '-i', src, '-af', TRIM_FILTER, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', dst],
        check=True, capture_output=True)


def cap_duration(path, max_dur):
    # speed up (pitch-preserving) so the clip is at most max_dur seconds
    dur = _dur(path)
    if dur <= max_dur:
        return
    f = dur / max_dur
    af = f'atempo={f:.4f}' if f <= 2.0 else f'atempo=2.0,atempo={f / 2:.4f}'
    tmp = path + '.cap.wav'
    subprocess.run(['ffmpeg', '-y', '-i', path, '-filter:a', af, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmp],
                   check=True, capture_output=True)
    os.replace(tmp, path)

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'games', 'doudizhu', 'voice'))
# one distinct voice per seat: 0=你/玩家, 1=下家, 2=上家
VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural']
RATE = '+8%'  # a touch snappier for game calls

# token -> slug (str), or a dict for per-token overrides:
#   text: what to actually synthesize (defaults to the token)
#   rate: speech rate override (defaults to RATE)
#   half: keep ~the first syllable of a reduplication (so 圈圈 → one 圈, forcing quān not juàn)
VOCAB = {
    '三': 'r3', '四': 'r4', '五': 'r5', '六': 'r6', '七': 'r7', '八': 'r8', '九': 'r9', '十': 'r10',
    '勾': 'rJ', '圈': {'slug': 'rQ', 'text': '圈圈', 'half': True}, 'K': 'rK', '尖': 'rA', '二': 'r2',
    '小王': 'jokerS', '大王': 'jokerB',
    '对': 'dui', '仨': 'sa', '带': 'dai', '俩': {'slug': 'lia', 'rate': '+40%', 'max_dur': 0.35},
    '串': 'chuan', '飞机': 'plane', '炸弹': 'bomb', '王炸': 'rocket', '四带二': 'four2',
    '1分': 'bid1', '2分': 'bid2', '3分': 'bid3', '过': 'guo',
    '我是地主': 'landlord',
}


def cfg_of(token, v):
    if isinstance(v, str):
        return {'slug': v, 'text': token, 'rate': RATE, 'half': False, 'max_dur': None}
    return {'slug': v['slug'], 'text': v.get('text', token), 'rate': v.get('rate', RATE),
            'half': v.get('half', False), 'max_dur': v.get('max_dur')}


def keep_first_syllable(path):
    # the clip is a reduplication (e.g. 圈圈) — keep just the first syllable so it says one quān. Cut to
    # ~55% then drop another 0.1s so none of the SECOND 圈's onset (the "q") leaks in; then re-trim.
    keep = max(0.10, _dur(path) * 0.55 - 0.10)
    tmp = path + '.cut.wav'
    subprocess.run(['ffmpeg', '-y', '-i', path, '-t', f'{keep:.3f}', '-af', TRIM_FILTER,
                    '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', tmp], check=True, capture_output=True)
    os.replace(tmp, path)


async def gen_seat(seat, voice, only):
    d = os.path.join(OUT, str(seat))
    os.makedirs(d, exist_ok=True)
    n = 0
    for token, v in VOCAB.items():
        c = cfg_of(token, v)
        if only and c['slug'] not in only:
            continue
        path = os.path.join(d, c['slug'] + '.wav')
        raw = os.path.join(d, c['slug'] + '.raw.mp3')
        await edge_tts.Communicate(c['text'], voice, rate=c['rate']).save(raw)
        trim_silence(raw, path)
        os.remove(raw)
        if c['half']:
            keep_first_syllable(path)
        if c['max_dur']:
            cap_duration(path, c['max_dur'])
        n += 1
    print(f'  seat {seat}: wrote {n} clips')


async def main():
    only = set(sys.argv[1:]) or None  # optional: regenerate only these slugs
    for seat, voice in enumerate(VOICES):
        print(f'voice {voice} -> seat {seat}')
        await gen_seat(seat, voice, only)
    print('done:', OUT)


if __name__ == '__main__':
    asyncio.run(main())
