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

import edge_tts

# edge-tts pads each utterance with ~1s of silence; for snappy, concatenable game calls we trim
# leading + trailing silence with ffmpeg (trim front, reverse, trim front again, reverse back).
_SR = 'silenceremove=start_periods=1:start_silence=0:start_threshold=-38dB:detection=peak'
TRIM_FILTER = f'{_SR},areverse,{_SR},areverse'


def trim_silence(src, dst):
    # output trimmed PCM WAV (24kHz mono 16-bit) — no codec/encoder-delay, so clips concatenate gaplessly
    subprocess.run(
        ['ffmpeg', '-y', '-i', src, '-af', TRIM_FILTER, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', dst],
        check=True, capture_output=True)

OUT = os.path.normpath(os.path.join(os.path.dirname(__file__), '..', 'games', 'doudizhu', 'voice'))
# one distinct voice per seat: 0=你/玩家, 1=下家, 2=上家
VOICES = ['zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural']
RATE = '+8%'  # a touch snappier for game calls

# token text -> filename slug (ASCII, so the paths are clean in sw.js / fetch).
VOCAB = {
    '三': 'r3', '四': 'r4', '五': 'r5', '六': 'r6', '七': 'r7', '八': 'r8', '九': 'r9', '十': 'r10',
    '勾': 'rJ', '圈': 'rQ', 'K': 'rK', '尖': 'rA', '二': 'r2', '小王': 'jokerS', '大王': 'jokerB',
    '对': 'dui', '仨': 'sa', '带': 'dai', '俩': 'lia',
    '串': 'chuan', '飞机': 'plane', '炸弹': 'bomb', '王炸': 'rocket', '四带二': 'four2',
    '1分': 'bid1', '2分': 'bid2', '3分': 'bid3', '过': 'guo',
    '我是地主': 'landlord',
}


async def gen_seat(seat, voice):
    d = os.path.join(OUT, str(seat))
    os.makedirs(d, exist_ok=True)
    print(f'voice {voice} -> seat {seat}')
    for text, slug in VOCAB.items():
        path = os.path.join(d, slug + '.wav')
        raw = os.path.join(d, slug + '.raw.mp3')
        await edge_tts.Communicate(text, voice, rate=RATE).save(raw)
        trim_silence(raw, path)
        os.remove(raw)
    print(f'  wrote {len(VOCAB)} clips (trimmed wav)')


async def main():
    for seat, voice in enumerate(VOICES):
        await gen_seat(seat, voice)
    print('done:', OUT)


if __name__ == '__main__':
    asyncio.run(main())
