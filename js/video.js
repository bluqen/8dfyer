// Video support via ffmpeg.wasm (single-threaded core), loaded lazily from a CDN.
// Used to (a) extract audio when the browser can't decode a video's audio track directly,
// and (b) remux the 8D audio over the original video stream.

// Self-hosted copies (same origin) of @ffmpeg/ffmpeg 0.12.10, @ffmpeg/util 0.12.1 and @ffmpeg/core 0.12.6.
// Same-origin avoids the cross-origin Worker and importScripts failures seen when loading from a CDN.
const BASE = new URL('../vendor/ffmpeg/', import.meta.url).href.replace(/\/$/, '');

let ffmpegPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

async function getFFmpeg(onStatus) {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      onStatus?.('Loading video engine (one-time ~30 MB download)…');
      await loadScript(`${BASE}/ffmpeg.js`);
      const { FFmpeg } = window.FFmpegWASM;
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: `${BASE}/ffmpeg-core.js`,
        wasmURL: `${BASE}/ffmpeg-core.wasm`
      });
      return ffmpeg;
    })().catch((e) => { ffmpegPromise = null; throw e; });
  }
  return ffmpegPromise;
}

const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || 'bin').toLowerCase();

/** Extract a video's audio track to WAV bytes (for decodeAudioData). */
export async function extractAudio(file, onStatus) {
  const ffmpeg = await getFFmpeg(onStatus);
  onStatus?.('Extracting audio from video…');
  const input = `in.${extOf(file.name)}`;
  await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
  const code = await ffmpeg.exec(['-i', input, '-vn', '-ac', '2', '-ar', '44100', '-f', 'wav', 'audio.wav']);
  await ffmpeg.deleteFile(input);
  if (code !== 0) throw new Error('No audio track found in this video.');
  const data = await ffmpeg.readFile('audio.wav');
  await ffmpeg.deleteFile('audio.wav');
  return data.buffer;
}

/** Replace the video's audio with the given WAV blob, copying the video stream untouched. */
export async function remuxWithAudio(file, wavBlob, onStatus) {
  const ffmpeg = await getFFmpeg(onStatus);
  onStatus?.('Merging 8D audio into video…');
  const input = `in.${extOf(file.name)}`;
  await ffmpeg.writeFile(input, new Uint8Array(await file.arrayBuffer()));
  await ffmpeg.writeFile('8d.wav', new Uint8Array(await wavBlob.arrayBuffer()));
  const code = await ffmpeg.exec([
    '-i', input, '-i', '8d.wav',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', 'out.mp4'
  ]);
  await ffmpeg.deleteFile(input);
  await ffmpeg.deleteFile('8d.wav');
  if (code !== 0) throw new Error('Could not merge audio into this video format.');
  const data = await ffmpeg.readFile('out.mp4');
  await ffmpeg.deleteFile('out.mp4');
  return new Blob([data.buffer], { type: 'video/mp4' });
}
