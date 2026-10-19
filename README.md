# 8Dfyer

Turn any audio or video file into **8D audio**, where the sound orbits around your head. Best with headphones.

Everything runs in the browser (Web Audio API). Files are never uploaded.

## Run

ES modules don't load over `file://`, so serve the folder:

```
python -m http.server 8080
# or
npx serve
```

Then open http://localhost:8080.

## How it works

The audio is mixed to mono and sent through an HRTF `PannerNode` whose position is automated around the listener (`x = r·sin θ`, `z = r·cos θ`). A low-pass filter muffles the sound when it is behind you, and a generated-impulse reverb adds space. The live preview and the exported file use the same graph (`js/engine.js`), the export through an `OfflineAudioContext`.

- **Audio files** are decoded with `decodeAudioData` and exported as WAV or MP3 (lamejs, loaded on demand).
- **Video files** try `decodeAudioData` first. If that fails, the audio is extracted with ffmpeg.wasm. "Download MP4" copies the original video stream and replaces its audio with the 8D version. ffmpeg.wasm (~30 MB) is only downloaded when needed.

## Notes

- Large files are decoded to raw PCM in memory, so very long or large files can be slow or fail.
- HRTF quality varies by browser; Chrome and Firefox are the best tested targets.
- MP4 export copies the video stream, so some source codecs (e.g. VP9 from WebM) may not fit an MP4 container.

## Hosting

This is a fully static site. Serve the folder as-is (GitHub Pages, Netlify, Cloudflare Pages, any static host). No build step and no special headers are needed.

## Credits

Video support uses [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/ffmpeg` 0.12.10, `@ffmpeg/core` 0.12.6), vendored in `vendor/ffmpeg/`. FFmpeg is licensed under the LGPL/GPL; see https://ffmpeg.org/legal.html. MP3 encoding uses [lamejs](https://github.com/zhuker/lamejs) (LGPL), loaded from a CDN on demand.
