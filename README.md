# Stitch Studio (v2)

A simple, step-by-step reel maker for my story reels. Built fresh, without the old code.

**Steps:** 1 Plan → 2 Record → 3 Clean → 4 Edit → 5 Export → 6 Post

Everything runs in Chrome on my laptop. Videos, takes and edits are saved in this browser (IndexedDB). Nothing is uploaded.

## What works now (build 1)

- **Plan:** reel name, hook, script.
- **Record:** record in the browser (front camera) or upload clips from the phone. Several takes. Optional scrolling script with a speed setting.
- **Clean:** one button.
  - Cuts pauses longer than 0.5 sec (adjustable under More options).
  - Cuts repeated lines and false starts, keeping the **last** take. This needs the transcript, which uses Whisper in the browser (transformers.js). The model downloads once on first use, then audio never leaves the laptop.
  - Shows the transcript with cuts crossed out. Tap anything to put it back or cut it.
  - Over 30 sec: splits into Part 1 and Part 2 at the end of a sentence.
- **Export:** MP4, 9:16, 1080×1920, under 30 sec only. Exports each part separately. Cover image picker and download.
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z) and autosave.

## Coming next (in this order)

1. **Text:** hook text, auto captions, "My style" (Poppins Black Italic, white, yellow key words, black outline and shadow, no box), font picker with previews and favorites, CapCut-style caption animations (word-by-word, karaoke highlight), text behind me.
2. **B-roll and image styles:** photos and clips over my voice, borders, rounded corners, shadow, polaroid, phone screen, notebook paper.
3. **Transitions and graphics:** cut, crossfade, swipes, zoom, flash, whip pan; arrows, circles, underlines, ✓ / ✗ stamps, sparkles, logo, my own PNGs.
4. **Post cards:** per-platform caption, time, rules, posted checkboxes.
5. **Calendar:** month/week plan, import my content calendar.

## Files

- `index.html`: page shell
- `css/app.css`: styles
- `js/app.js`: steps and screens
- `js/clean.js`: pause, repeat and false-start detection; kept ranges; split
- `js/audio.js`: decoding and loudness
- `js/whisper-worker.js`: in-browser transcript
- `js/export.js`: MP4 export and cover frames
- `js/store.js`: autosave
