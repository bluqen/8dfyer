// WAV (built in) and MP3 (lamejs, lazy-loaded) encoders for an AudioBuffer.

export function encodeWav(buffer) {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const out = new DataView(new ArrayBuffer(44 + dataSize));

  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) out.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  out.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, channels, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true);
  out.setUint16(32, channels * bytesPerSample, true);
  out.setUint16(34, 16, true);
  writeStr(36, 'data');
  out.setUint32(40, dataSize, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      out.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([out], { type: 'audio/wav' });
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}

export async function encodeMp3(buffer, kbps = 192) {
  if (!window.lamejs) await loadScript('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
  const toInt16 = (f32) => {
    const i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return i16;
  };
  const left = toInt16(buffer.getChannelData(0));
  const right = buffer.numberOfChannels > 1 ? toInt16(buffer.getChannelData(1)) : left;
  const encoder = new window.lamejs.Mp3Encoder(2, buffer.sampleRate, kbps);
  const chunks = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const buf = encoder.encodeBuffer(left.subarray(i, i + block), right.subarray(i, i + block));
    if (buf.length) chunks.push(new Uint8Array(buf));
  }
  const end = encoder.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  return new Blob(chunks, { type: 'audio/mpeg' });
}
