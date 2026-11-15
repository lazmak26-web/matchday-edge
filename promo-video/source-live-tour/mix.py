# Audio mix used in the Higgsfield sandbox: voice-over lines placed at their section times, music ducked under the voice.
import json, subprocess
t = json.load(open("timing.json"))["vo_at"]; END = 197.66
ins = ["-i", "in/music.wav"]; f = []; keys = sorted(t)
for i, k in enumerate(keys, 1):
    ins += ["-i", f"in/vo_{k}.wav"]; ms = int(t[k] * 1000); f.append(f"[{i}]adelay={ms}|{ms},volume=1.15[v{i}]")
f.append("".join(f"[v{i}]" for i in range(1, len(keys) + 1)) + f"amix=inputs={len(keys)}:normalize=0:duration=longest,apad,atrim=0:{END}[vo]")
f.append("[vo]asplit=2[vo1][vo2]")
f.append(f"[0]atrim=0:{END},asetpts=N/SR/TB,volume=0.30,afade=t=in:d=0.6,afade=t=out:st={END-3.5}:d=3.5[m]")
f.append("[m][vo1]sidechaincompress=threshold=0.015:ratio=7:attack=25:release=450:makeup=1[md]")
f.append("[md][vo2]amix=inputs=2:normalize=0:duration=first,loudnorm=I=-16:TP=-1.5:LRA=11[out]")
subprocess.run(["ffmpeg", "-y", "-v", "error", *ins, "-filter_complex", ";".join(f), "-map", "[out]", "-ar", "48000", "-ac", "2", "mix.wav"], check=True)
