# Stitch Studio (v2)

A simple, step-by-step reel maker for my story reels. Built fresh, without the old code.

**Steps:** 1 Plan → 2 Record → 3 Clean → 4 Edit → 5 Export → 6 Post

Everything runs in Chrome on my laptop. Videos, takes and edits are saved in this browser (IndexedDB). Nothing is uploaded.

## What works now (build 1)

- **Plan:** pick **Me on camera** or **Voice-over**, then reel name, hook, script.
- **Record:** record in the browser (front camera) or upload clips from the phone. Several takes. Optional scrolling script with a speed setting.
- **Voice-over mode:** record or upload just your voice, then add photos, clips or screen recordings to play on screen in order (set seconds for each, or leave blank to share the time evenly). Photos get a slow push-in. Clean and export work the same way.
- **Clean:** one button.
  - Cuts pauses longer than 0.5 sec (adjustable under More options).
  - Cuts repeated lines and false starts, keeping the **last** take. This needs the transcript, which uses Whisper in the browser (transformers.js). The model downloads once on first use, then audio never leaves the laptop.
  - Shows the transcript with cuts crossed out. Tap anything to put it back or cut it.
  - Over 30 sec: splits into Part 1 and Part 2 at the end of a sentence.
- **Export:** MP4, 9:16, 1080×1920, under 30 sec only. Exports each part separately. Cover image picker and download.
- Undo / redo (Ctrl+Z / Ctrl+Shift+Z) and autosave.

## Build 2: Text (Edit step)

- **Hook text** for the first seconds (from Plan or typed). Put *stars* around a word to highlight it. Pop, bounce or fade in. Part 2 gets its own label.
- **Auto captions** from the transcript: 1–4 words at a time, karaoke (the word lights up as you say it), word by word, pop, bounce or fade.
- Tap a caption word to **highlight** it, **make it bigger**, or **fix its spelling**.
- **List lines** that appear one at a time.
- **Style** for each: 20 fonts previewed with your words, weight, italic, ALL CAPS, size, text color, highlight color, outline thickness and color, drop shadow. Brand color quick picks plus any color. **Presets** you can save and reuse. Default is My style.
- **Drag** text on the preview to move it. Scrub to any second to check it.
- **Behind me:** text sits behind your head and shoulders (MediaPipe person cutout in the browser; on-camera reels).
- Preview, export and cover images all show the text.

## Build 3: B-roll and image styles (Edit → B-roll)

- Move the slider to a moment, then **add a photo or clip there**. Your voice keeps playing; clip sound is muted.
- Set when it starts ("Use this second") and how long it stays.
- **Full screen** or **Framed over me**. Pop, fade or slide in.
- Frames: **Plain** (border thickness and color, rounded corners), **Polaroid** (with a handwritten caption), **Phone screen**, **Notebook paper** (with tape). Size, tilt and drop shadow for all.
- Drag framed B-roll on the preview to place it. Duplicate or remove any item.
- Works in on-camera and voice-over reels, across Part 1 and Part 2, in preview, export and covers.

## B-roll library

- In Edit → B-roll: **📚 B-roll library**, kept for every reel ("Start a new reel" never clears it).
- Upload straight into a category, or tap **Save to library** on any B-roll in a reel.
- Starter categories (from the B-roll shot list): Reactions, Building HealthQuest, Screen recordings, Nurse / clinic, Roots / Filipino, Tennis, Books, Mission / $19B, Mom life. Add, rename or delete categories anytime.
- Filter by category, search by name, give one item several categories (🏷), rename (✎), delete (✕).
- Tap a tile to drop it into the reel at the slider's second.
- Saved in this browser only, like everything else.

## Build 4: Transitions, mirror effects, graphics and stamps

**Edit → Transitions & mirror**
- One look for every cut: hard cut, crossfade, swipe left/right/up, zoom in, flash, whip pan. Length slider (default 0.3 sec). Change any single cut, with "See it" to preview. Transitions don't add time.
- Mirror effects for any stretch (or the whole reel): mirror split left/right or top/bottom, repeat grid 2×2 or 3×3, side-by-side clones, kaleidoscope. Text, B-roll and graphics stay on top.

**Edit → Graphics & stamps**
- ✓ / ✗ stamps (rubber-stamp look, optional word like FACT or MYTH, "stamp slam" animation), check, cross, arrow, circle and underline (draw on), sparkles, star burst (optional word), any emoji, the HealthQuest logo, your own PNGs.
- Start time, length, size, rotation, brand colors, animation. Drag on the preview to place. Duplicate or remove.

## Build 5: Post cards

- Pick the posting date. Write your caption once, pick a closer, set the YouTube title.
- One card per platform (Instagram, Facebook Page, Facebook personal, TikTok, YouTube Shorts) with its post time, its rules, a ready caption and a Copy button:
  - Instagram: "Link in bio", 5 hashtags, sign-off, reminder to add @healthquestapp as Collaborator.
  - Facebook Page and personal: the full clickable link, sign-off.
  - TikTok: shorter caption, no sign-off.
  - YouTube Shorts: title and short description, #Shorts, no sign-off.
- Through Dec 31 every caption carries the tester line (Facebook gets the sign-up link). After that it drops off by itself.
- Edit any card's caption by hand (Reset brings the template back). Tick Posted on each; when all five are ticked the reel is marked Posted.
- Settings (apply to every reel): post times for Tue/Wed/Thu, Facebook personal time, links, tester line and end date, sign-off, closers, hashtags.

## Build 6: Calendar (home screen) and multiple reels

- **Plan** opens on your calendar: month or week view, Today, back/forward.
- **Import calendar** (.xlsx or .csv, read in the browser). Brings in date, type, topic, hook, script, where, post times, caption notes and status. Importing again updates dates and text and keeps your reels and progress.
- Colors: green = reel, purple = ad or holiday Story, peach = Reddit. Each post shows its status, a yellow "to fill" tag while its script still has [brackets], and a warning if a Part 2 isn't the day after its Part 1.
- Tap a post to edit its topic, hook, script (brackets highlighted), date, type and status. Drag a post to another day. ＋ adds a post to any day.
- **Start this reel** makes a new reel with that day's hook, script and date, and opens Record. Status updates on its own: Recorded, Edited (after export), Posted (all five post cards ticked).
- Every reel is kept. **Start a new reel** no longer clears anything; switch between reels under **My reels** (delete there too).
- Recording warns you if the script still has [brackets].

## Split tool (Edit, above the tabs)

- Move the slider and tap **✂ Split** to cut the reel into sections. Tap ✂ on a split line to remove it.
- Tap a section to change just that part: **mirror it**, **cover it with B-roll** (upload or from the library, full screen for the whole section), **play it**, or **remove it**.
- Removing a section shortens the reel; B-roll, mirror and graphics after it move up to stay in sync. It shows in Clean as "✂ removed", tap to put it back (or Undo).
- Colored lanes under the sections show where B-roll, mirror and graphics are.

## Coming next

Nothing left on the build list. Next: whatever comes up from real reels.

## Files

- `index.html`: page shell
- `css/app.css`: styles
- `js/app.js`: steps and screens
- `js/clean.js`: pause, repeat and false-start detection; kept ranges; split
- `js/audio.js`: decoding and loudness
- `js/whisper-worker.js`: in-browser transcript
- `js/export.js`: MP4 export and cover frames
- `js/text.js`: hook, captions, list drawing and styles
- `js/segment.js`: text behind me
- `js/calendar.js`: calendar import (.xlsx/.csv), colors, checks
- `js/post.js`: post cards, caption templates, post times
- `js/fx.js`: mirror effects, transitions, graphics and stamps
- `assets/healthquest-logo.png`: logo for the graphics tab
- `js/library.js`: B-roll library and categories
- `js/broll.js`: B-roll and frames
- `js/visuals.js`: voice-over visuals timeline
- `js/store.js`: autosave
