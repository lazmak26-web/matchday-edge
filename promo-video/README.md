# LuciBet — Match Day Edge · promo videos

## Main video: `LuciBet-MatchDayEdge-LIVE-TOUR.mp4`
3m17s · 1920×1080 · 30 fps · H.264 + AAC (−16.7 LUFS)

A live walkthrough of the real site (15 Nov 2026, Pro account): Playwright drives the dashboard
(cursor, clicks, search, sliders, tabs, language switch) and the edit is built in Higgsfield.

| Part | Made with |
|---|---|
| Live footage of the site | Playwright + Chrome screencast (`source-live-tour/tour.js`, `overlay.js`) |
| Voice-over (12 lines, voice "Romy") | Higgsfield · seed_audio |
| Music (3m20s instrumental) | Higgsfield · ElevenLabs Music v2.5 |
| Titles, section labels, subtitles, zooms, intro/outro | Higgsfield · Higgsedit (`source-live-tour/gen.py` → `edit.jsx`) |
| Voice/music mix with ducking | ffmpeg in the Higgsfield sandbox (`source-live-tour/mix.py`) |

Sections: 01 Signals · 02 Match model · 03 Value bets · 04 Model filters · 05 Bot history ·
06 Discover · 07 League tables · 08 Demo arena · 09 Settings · 10 Pro access.

The tour is read-only on the account: no posts, no Share, no predictions. Filters, pins, theme and
language live only in the recording browser. Email and username are blurred automatically.

### Re-record
1. Log in on the site, put the session token in `.tok` next to the `source-live-tour` folder.
2. `node source-live-tour/tour.js` → frames + `index.json` + `marks.json`, then `python3 assemble.py`
   and `ffmpeg -f concat -safe 0 -i list.txt -vf fps=30,scale=1920:1080 -c:v libx264 -crf 17 tour_raw.mp4`.
3. Update the section times `M` in `gen.py` from `marks.json`, then run `gen.py` + `higgsedit build edit.jsx`
   + `higgsedit render proj` in the Higgsfield sandbox, then `mix.py` and mux.

## Other versions
- `LuciBet-MatchDayEdge-promo-REAL.mp4` — 73 s motion-graphics cut from real screenshots (`source-real/`).
- `source-demo/` — first mock-data version. Do not publish its output: its track-record numbers are not real.

No win-rate or profit claims are made: the site's "93% win rate" counts a match as won when any one of
its three picks wins, so it is left out on purpose.
