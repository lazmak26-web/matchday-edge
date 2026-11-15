# LuciBet — Match Day Edge · promo video

`LuciBet-MatchDayEdge-promo.mp4` — 73 s, 1920×1080, 30 fps, H.264 + AAC (−16 LUFS).
Music: ElevenLabs Music v2.5 via Higgsfield (instrumental, started at 3.7 s so the lift lands on 04 VALUE BETS).

## Re-render
```bash
cd promo-video/source
node render.js video_silent.mp4          # deterministic: every frame is computed from time T
ffmpeg -i video_silent.mp4 -ss 3.7 -i music.mp3 -map 0:v -map 1:a -c:v copy \
  -af "afade=t=in:d=0.6,afade=t=out:st=71.5:d=1.5,loudnorm=I=-16:TP=-1.5:LRA=11" \
  -c:a aac -b:a 192k -shortest -movflags +faststart ../LuciBet-MatchDayEdge-promo.mp4
```
Edit text, numbers or timings in `promo.html` (each `scene(t0, t1, ...)` block is one section).
