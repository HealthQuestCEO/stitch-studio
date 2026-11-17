# Stitch Studio

A browser-based maker for 9:16 short videos (Reels, TikTok, YouTube Shorts, Facebook). Everything runs on your own computer. Videos are never uploaded anywhere.

**Live:** https://healthquestceo.github.io/stitch-studio/

## Formats

- **Teleprompter**: words scroll up the screen in time with your up-swipes. A side swipe at the end of a clip slides to the next clip.
- **Scene swipes**: one clip per scene. A swipe or camera move (sideways, or a tilt up or down) carries you to the next clip. The next scene's words can slide in or type out as you swipe.
- **React & respond**: a video or photo you're reacting to, then you. Choose Stitch, Picture-in-picture, or Split screen.
- **Explainer cards**: no camera. Your voiceover over animated cards: a headline with accent words, a screenshot or photo that pops in, tags that pop in one by one, a big number that counts up, a "Comment KEYWORD" card with letter tiles, and a Follow card. Paper, dark or solid-color backgrounds. "Stretch cards to fit the voiceover" lines them up with your audio.
- **Green screen**: your video with the green removed, over a color, photo, or looping video background, with words behind you (still or scrolling).

Green screen also has effects: **Mirror twin** (two of you facing each other), **Sliced** (you split into strips that snap together on a beat), **Big and small** (you jump between tiny and huge), and **Inside the head** (your outline filled with the background photo or video).

## Post planner

Open it with **Post planner** at the top.

- **When to post**: a day-by-hour score for Instagram, Facebook, TikTok or YouTube Shorts, a "Good time to post / Don't post yet" check for right now, and your next posts for the week. Scores start from Sprout Social's 2026 study plus health-and-wellness windows, then lean on your Instagram "Most active times" if you enter them, then on your own logged results.
- **Format & hook**: pick what the post is about and it ranks Stitch formats (plus talking head and faceless graphics), suggests a hook type (Experience, Contrast, Curiosity, Proof) and gives fill-in hook starters you can drop straight into your words.
- **Post log**: log each post's numbers a couple of days after it goes up. Times, formats and hooks that beat your usual post move up. Download or load the log as CSV.

## Shared across every format

- Words with `*emphasis*`, `---` section breaks, and inline images
- Fonts, emphasis styles (bolder, color, marker, underline), text styles
- B-roll photos with full screen, card, or top-half layouts and fade, slide, or zoom transitions
- Timed captions and True/False/Myth/Fact stamps with pop, typewriter, word-by-word, or slide-up animation
- Caption call-out stamp ("Read the caption ↓" and other presets, or custom text): sits on the last 3 seconds by default, has a gently bouncing arrow, and can be dragged in the preview but stays inside the safe zone
- Phone notification: a text or email banner drops in at any point (with an optional notification sound), opens to a full screen built from your text or your own screenshot when you tap it, then goes picture-in-picture with you or the screen in the corner. The fake screens use generic icons, never a real app's logo
- Series label: a small corner label that stays on for the whole video (for example READING YOUR LABS · 1). It remembers the last text used and can be dragged
- Words per clip (Teleprompter and Scene swipes): each clip picks which `---` section it shows, or none, so the scrolling words can ride on whichever clip actually has the swipes
- Trim & split: a filmstrip editor on every uploaded clip with draggable start/end handles, a scrub-able mini preview, frame-by-frame nudging and Start here / End here. Teleprompter and Scene swipes clips can also be split into separate clips (for videos made as one long take in Edits)
- Per-layer volume
- Save progress (button or Cmd/Ctrl+S): saves the whole project, videos and photos included, in this browser. It reopens automatically after a reload, and the Formats screen lists saved projects to open or delete
- Safe-zone guides (preview only)
- Export to 1080×1920 with audio (MP4 in recent Chrome and Safari, otherwise WebM)

## Green screen from Canva

Remove your background in Canva, put a solid bright-green rectangle behind you, and download as MP4. Stitch Studio removes the green.

## Hosting

This is a single static file (`index.html`). GitHub Pages serves it from the `main` branch root.
