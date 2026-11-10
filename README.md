# Stitch Studio

A browser-based maker for 9:16 short videos (Reels, TikTok, YouTube Shorts, Facebook). Everything runs on your own computer. Videos are never uploaded anywhere.

**Live:** https://healthquestceo.github.io/stitch-studio/

## Formats

- **Teleprompter**: words scroll up the screen in time with your up-swipes. A side swipe at the end of a clip slides to the next clip.
- **Scene swipes**: one clip per scene. A swipe or camera move (sideways, or a tilt up or down) carries you to the next clip. The next scene's words can slide in or type out as you swipe.
- **React & respond**: a video or photo you're reacting to, then you. Choose Stitch, Picture-in-picture, or Split screen.
- **Green screen**: your video with the green removed, over a color, photo, or looping video background, with words behind you (still or scrolling).

## Shared across every format

- Words with `*emphasis*`, `---` section breaks, and inline images
- Fonts, emphasis styles (bolder, color, marker, underline), text styles
- B-roll photos with full screen, card, or top-half layouts and fade, slide, or zoom transitions
- Timed captions and True/False/Myth/Fact stamps with pop, typewriter, word-by-word, or slide-up animation
- Caption call-out stamp ("Read the caption ↓" and other presets, or custom text): sits on the last 3 seconds by default, has a gently bouncing arrow, and can be dragged in the preview but stays inside the safe zone
- Series label: a small corner label that stays on for the whole video (for example READING YOUR LABS · 1). It remembers the last text used and can be dragged
- Per-layer volume
- Safe-zone guides (preview only)
- Export to 1080×1920 with audio (MP4 in recent Chrome and Safari, otherwise WebM)

## Green screen from Canva

Remove your background in Canva, put a solid bright-green rectangle behind you, and download as MP4. Stitch Studio removes the green.

## Hosting

This is a single static file (`index.html`). GitHub Pages serves it from the `main` branch root.
