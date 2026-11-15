# LuciBet — Match Day Edge · promo video

**Use this one:** `LuciBet-MatchDayEdge-promo-REAL.mp4` — 73.6 s, 1920×1080, 30 fps, H.264 + AAC (−16 LUFS).
Every panel is a real screenshot of the live site (15 Nov 2026, Pro account), with personal info blurred.
Music: ElevenLabs Music v2.5 via Higgsfield (instrumental, starts at 6.4 s of the track).

Sections: hook → logo line → 01 Signals → 02 Match model → 03 Value bets → 04 Model filters →
05 Discover → 06 Bot history → 07 League tables → 08 Demo arena → 09 Pro access → outro.

Numbers shown are taken from the site as captured: 93 matches, +8.57% best EV (Cádiz @ 5.39),
92.1% Over 1.5 probability, 4.5% min EV filter, 928 matches tracked, Arsenal 27 pts, 2,000 DH demo start, $30 Pro.
No win-rate or profit claims: the site's "93% win rate" counts a match as won when any one of its
three picks wins, so it is left out on purpose.

`source-demo/` is the first, mock-data version. Do not publish its output: its track-record numbers are not real.

## Re-render
```bash
cd promo-video/source-real
node render.js video_silent.mp4
ffmpeg -i video_silent.mp4 -ss 6.4 -i music.mp3 -map 0:v -map 1:a -c:v copy \
  -af "afade=t=in:d=0.6,apad,loudnorm=I=-16:TP=-1.5:LRA=11" -t 73.6 \
  -c:a aac -b:a 192k -movflags +faststart ../LuciBet-MatchDayEdge-promo-REAL.mp4
```
Each `scene(t0, t1, ...)` block in `promo.html` is one section; `shot(..., [fromRect, toRect], ...)` sets the camera zoom.
