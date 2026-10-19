import { DEFAULTS, Previewer, render8D } from './engine.js';
import { encodeWav, encodeMp3 } from './encoder.js';

const $ = (id) => document.getElementById(id);
const els = {
  dropzone: $('dropzone'), dzTitle: $('dzTitle'), file: $('file'), chooseBtn: $('chooseBtn'), replaceBtn: $('replaceBtn'),
  status: $('status'), errorBox: $('errorBox'), editor: $('editor'),
  fileName: $('fileName'), fileMeta: $('fileMeta'), videoTag: $('videoTag'),
  videoBox: $('videoBox'), video: $('video'), videoTime: $('videoTime'),
  playBtn: $('playBtn'), progressBar: $('progressBar'), progressTrack: $('progressTrack'),
  elapsed: $('elapsed'), duration: $('duration'),
  orbit: $('orbit'), orbitRing: $('orbitRing'), orbitDot: $('orbitDot'), orbitSpin: $('orbitSpin'),
  period: $('period'), periodOut: $('periodOut'), radius: $('radius'), radiusOut: $('radiusOut'),
  reverb: $('reverb'), reverbOut: $('reverbOut'), direction: $('direction'), vertical: $('vertical'),
  dlWav: $('dlWav'), dlMp3: $('dlMp3'), dlVideo: $('dlVideo')
};

const MAX_WARN_BYTES = 500 * 1024 * 1024;
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|flv|wmv|3gp)$/i;

let currentFile = null;
let buffer = null;
let isVideo = false;
let videoUrl = null;
let previewer = null;
let raf = 0;

function setStatus(msg, kind = '') {
  // kind: '' | 'busy' | 'done' | 'error'
  // Errors show in a box under the hero so the current page stays usable beneath it.
  const isError = kind === 'error';
  els.errorBox.hidden = !(isError && msg);
  els.errorBox.textContent = isError ? msg || '' : '';
  const text = isError ? '' : msg;
  els.status.hidden = !text;
  els.status.textContent = text || '';
  els.status.className = 'status' + (kind && !isError ? ' ' + kind : '');
}

function getOpts() {
  return {
    period: Number(els.period.value) || DEFAULTS.period,
    direction: Number(els.direction.value) || DEFAULTS.direction,
    radius: Number(els.radius.value) || DEFAULTS.radius,
    reverb: Number(els.reverb.value) / 100,
    vertical: els.vertical.checked
  };
}

function fmtTime(s) {
  s = Math.round(s);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function updateOutputs() {
  els.periodOut.textContent = `${els.period.value} s per orbit`;
  els.radiusOut.textContent = els.radius.value;
  els.reverbOut.textContent = `${els.reverb.value}%`;
  updateOrbit();
}

function updateOrbit() {
  const dist = Number(els.radius.value);
  const ccw = els.direction.value === '-1';
  const r = 16 + dist * 4.2;
  els.orbitRing.setAttribute('r', r);
  els.orbitRing.setAttribute('stroke-dasharray', els.vertical.checked ? '2 4' : 'none');
  els.orbitDot.setAttribute('cy', 56 - r);
  els.orbitSpin.style.animationDuration = `${els.period.value}s`;
  els.orbitSpin.classList.toggle('reverse', ccw);
  els.orbit.setAttribute('aria-label',
    `Top-down view: sound orbiting the listener ${ccw ? 'counter-clockwise' : 'clockwise'}`);
}

function setPlayingUI(playing) {
  els.playBtn.classList.toggle('playing', playing);
  els.playBtn.setAttribute('aria-label', playing ? 'Pause preview' : 'Play preview');
  els.orbitSpin.classList.toggle('running', playing);
}

function setBusy(busy) {
  for (const b of [els.dlWav, els.dlMp3, els.dlVideo, els.playBtn]) b.disabled = busy;
}

async function decodeBytes(bytes) {
  const ctx = new AudioContext();
  try {
    return await ctx.decodeAudioData(bytes);
  } finally {
    ctx.close();
  }
}

function resetVideo() {
  els.video.pause();
  els.video.removeAttribute('src');
  els.video.load();
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = null;
}

function setProgress(fraction, position) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  els.progressBar.style.width = `${pct}%`;
  els.progressTrack.setAttribute('aria-valuenow', String(Math.round(pct)));
  els.elapsed.textContent = fmtTime(position);
  els.videoTime.textContent = `${fmtTime(position)} / ${fmtTime(buffer.duration)}`;
}

function describeError(first, last, file) {
  const msg = (last && last.message) || String(last);
  const big = file.size > 150 * 1024 * 1024;
  if (/memory|allocation|quota|array buffer|out of bounds|abort/i.test(`${first?.message} ${msg}`) || (big && first?.name === 'EncodingError')) {
    return 'This file is probably too long or large to process in the browser, because the whole soundtrack is decoded into memory. Try a shorter clip, around 30 minutes or less.';
  }
  if (/Failed to load|network|fetch|import/i.test(msg)) {
    return `The video engine could not be downloaded (${msg}). Check your connection and try again.`;
  }
  if (/No audio track/i.test(msg)) return 'This video has no audio track.';
  return `${msg || 'Unsupported or damaged file.'} Try another file, or export it as MP3 or WAV first.`;
}

async function loadFile(file) {
  const nextIsVideo = file.type.startsWith('video/') || VIDEO_EXT.test(file.name);
  stopPreview();
  els.errorBox.hidden = true;

  setStatus(file.size > MAX_WARN_BYTES
    ? 'Large file: decoding uses a lot of memory and may fail or be slow.'
    : 'Reading file…', 'busy');

  // Decode first; the current page is only replaced once the new file works.
  let decoded;
  let firstErr = null;
  try {
    try {
      decoded = await decodeBytes(await file.arrayBuffer());
    } catch (e) {
      firstErr = e;
      console.warn('Direct decode failed:', e);
      if (!nextIsVideo) throw e;
      const { extractAudio } = await import('./video.js');
      decoded = await decodeBytes(await extractAudio(file, (m) => setStatus(m, 'busy')));
    }
  } catch (e) {
    console.error(e);
    const reason = describeError(firstErr || e, e, file);
    setStatus(`Could not read audio from ${file.name}. ${reason}`, 'error');
    return;
  }

  previewer?.dispose();
  previewer = null;
  resetVideo();
  buffer = decoded;
  currentFile = file;
  isVideo = nextIsVideo;

  els.fileName.textContent = file.name;
  els.fileMeta.textContent = fmtTime(buffer.duration);
  els.duration.textContent = fmtTime(buffer.duration);
  els.videoTag.hidden = !isVideo;
  els.dlVideo.hidden = !isVideo;
  els.videoBox.hidden = !isVideo;
  if (isVideo) {
    videoUrl = URL.createObjectURL(file);
    els.video.muted = true; // the 8D audio comes from the Web Audio preview
    els.video.src = videoUrl;
  }
  els.dropzone.hidden = true;
  els.editor.hidden = false;
  setPlayingUI(false);
  setProgress(0, 0);
  setStatus('');

  previewer = new Previewer(buffer, getOpts, () => {
    setPlayingUI(false);
    cancelAnimationFrame(raf);
    setProgress(0, 0);
    if (isVideo) { els.video.pause(); els.video.currentTime = 0; }
  });
}

function syncVideo() {
  if (!isVideo || !videoUrl) return;
  els.video.currentTime = previewer.position;
  els.video.play().catch(() => {});
}

function tick() {
  if (!previewer?.playing) return;
  setProgress(previewer.position / buffer.duration, previewer.position);
  raf = requestAnimationFrame(tick);
}

function stopPreview() {
  previewer?.pause();
  cancelAnimationFrame(raf);
  if (isVideo) els.video.pause();
  setPlayingUI(false);
}

async function togglePreview() {
  if (!previewer) return;
  if (previewer.playing) {
    stopPreview();
  } else {
    await previewer.play();
    setPlayingUI(true);
    syncVideo();
    tick();
  }
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const baseName = () => currentFile.name.replace(/\.[^.]+$/, '');

async function exportAs(kind) {
  if (!buffer) return;
  stopPreview();
  setBusy(true);
  try {
    setStatus('Rendering 8D audio…', 'busy');
    const rendered = await render8D(buffer, getOpts());
    if (kind === 'wav') {
      download(encodeWav(rendered), `${baseName()}-8d.wav`);
    } else if (kind === 'mp3') {
      setStatus('Encoding MP3…', 'busy');
      download(await encodeMp3(rendered), `${baseName()}-8d.mp3`);
    } else {
      const { remuxWithAudio } = await import('./video.js');
      download(await remuxWithAudio(currentFile, encodeWav(rendered), (m) => setStatus(m, 'busy')), `${baseName()}-8d.mp4`);
    }
    setStatus('Done! Your file has been downloaded.', 'done');
  } catch (e) {
    console.error(e);
    setStatus(`Export failed: ${e.message || e}`, 'error');
  } finally {
    setBusy(false);
  }
}

// --- wiring ---
const openPicker = () => els.file.click();
els.chooseBtn.addEventListener('click', openPicker);
els.replaceBtn.addEventListener('click', openPicker);
els.file.addEventListener('change', () => {
  const f = els.file.files[0];
  if (f) loadFile(f);
  els.file.value = '';
});

// Drag and drop works on the whole page so it also replaces a loaded file.
const DZ_TITLE = els.dzTitle.textContent;
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  els.dropzone.classList.add('over');
  els.dzTitle.textContent = 'Release to load the file';
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  els.dropzone.classList.remove('over');
  els.dzTitle.textContent = DZ_TITLE;
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  els.dropzone.classList.remove('over');
  els.dzTitle.textContent = DZ_TITLE;
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

els.playBtn.addEventListener('click', togglePreview);
els.video.addEventListener('click', togglePreview);
for (const input of [els.period, els.radius, els.reverb, els.direction, els.vertical]) {
  input.addEventListener('input', updateOutputs);
  // Restart the preview graph once the user releases the control.
  input.addEventListener('change', () => { previewer?.refresh(); syncVideo(); });
}
els.dlWav.addEventListener('click', () => exportAs('wav'));
els.dlMp3.addEventListener('click', () => exportAs('mp3'));
els.dlVideo.addEventListener('click', () => exportAs('video'));
updateOutputs();
