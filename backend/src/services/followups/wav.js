// ============================================================
// WAV -- phone audio, in pure JavaScript (no ffmpeg on the server).
//
// Exotel plays WAV at 8 kHz, 16-bit, mono. Everything a prerecorded call
// plays is turned into exactly that here:
//   parseWav()     read a PCM WAV (8/16/24/32-bit integer or 32-bit float,
//                  any sample rate, any channel count)
//   toPhoneWav()   downmix + resample to 8 kHz mono 16-bit
//   joinPhoneWavs  the automated-call notice + the recording + the keypad
//                  menu as ONE file (Exotel's Gather plays one URL)
// The browser converts MP3/M4A/OGG/WebM to WAV before upload (the server
// cannot decode compressed audio); anything that is not a PCM WAV is refused
// with a plain reason.
// ============================================================

export const PHONE_RATE = 8000;
export const MAX_RECORDING_SECS = 120;
export const MIN_RECORDING_SECS = 1;

const fail = (msg) => Object.assign(new Error(msg), { status: 422 });

/** { rate, channels, bits, format, frames, read(frame, channel) -> -1..1 } */
export function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) throw fail('That file is not a WAV recording.');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw fail('That file is not a WAV recording.');
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);   // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format
      fmt = { format, channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      data = { start: body, length: Math.min(size, buf.length - body) };
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw fail('That WAV file has no audio in it.');
  const { format, channels, rate, bits } = fmt;
  const okInt = format === 1 && [8, 16, 24, 32].includes(bits);
  const okFloat = format === 3 && bits === 32;
  if (!okInt && !okFloat) throw fail('Only uncompressed (PCM) WAV can be used. Upload the file through the page, which converts it.');
  if (!channels || channels > 8 || rate < 4000 || rate > 192000) throw fail('That WAV file has an unusual format.');
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const read = (frame, ch) => {
    const p = data.start + (frame * channels + ch) * bytes;
    if (okFloat) return Math.max(-1, Math.min(1, buf.readFloatLE(p)));
    if (bits === 8) return (buf.readUInt8(p) - 128) / 128;
    if (bits === 16) return buf.readInt16LE(p) / 32768;
    if (bits === 24) return buf.readIntLE(p, 3) / 8388608;
    return buf.readInt32LE(p) / 2147483648;
  };
  return { rate, channels, bits, format, frames, read };
}

/** Mono 16-bit PCM samples -> a WAV file. */
export function encodeWav(samples, rate = PHONE_RATE) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i], 44 + i * 2);
  return out;
}

/** 8 kHz mono Int16 samples from any parsed WAV (box-filter decimation, so speech stays clean). */
function phoneSamples(w) {
  const mono = (f) => { let s = 0; for (let c = 0; c < w.channels; c++) s += w.read(f, c); return s / w.channels; };
  const ratio = w.rate / PHONE_RATE;
  const n = Math.floor(w.frames / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let v;
    if (ratio <= 1) {
      const x = i * ratio;
      const a = Math.floor(x);
      const b = Math.min(w.frames - 1, a + 1);
      v = mono(a) + (mono(b) - mono(a)) * (x - a);
    } else {
      const from = Math.floor(i * ratio);
      const to = Math.max(from + 1, Math.min(w.frames, Math.floor((i + 1) * ratio)));
      let s = 0;
      for (let f = from; f < to; f++) s += mono(f);
      v = s / (to - from);
    }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return out;
}

/**
 * Any PCM WAV -> { wav: phone-ready Buffer, seconds, peak }.
 * `peak` (0..1) lets the caller refuse a silent recording.
 */
export function toPhoneWav(buf) {
  const w = parseWav(buf);
  const samples = phoneSamples(w);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const a = Math.abs(samples[i]); if (a > peak) peak = a; }
  return { wav: encodeWav(samples), seconds: samples.length / PHONE_RATE, peak: peak / 32767 };
}

/** Several WAVs (any PCM format) joined with a short pause between them. */
export function joinPhoneWavs(buffers, gapMs = 350) {
  const parts = buffers.filter(Boolean).map((b) => phoneSamples(parseWav(b)));
  const gap = Math.round((gapMs / 1000) * PHONE_RATE);
  const total = parts.reduce((n, p) => n + p.length, 0) + gap * Math.max(0, parts.length - 1);
  const out = new Int16Array(total);
  let at = 0;
  parts.forEach((p, i) => { out.set(p, at); at += p.length + (i < parts.length - 1 ? gap : 0); });
  return encodeWav(out);
}

/** Validate an upload for use as a prerecorded message. */
export function checkRecording(buf) {
  const { wav, seconds, peak } = toPhoneWav(buf);
  if (seconds < MIN_RECORDING_SECS) throw fail('The recording is shorter than a second.');
  if (seconds > MAX_RECORDING_SECS) throw fail(`Keep the recording under ${MAX_RECORDING_SECS / 60} minutes (this one is ${Math.round(seconds)} seconds).`);
  if (peak < 0.01) throw fail('The recording is silent. Check the microphone and try again.');
  return { wav, seconds: Math.round(seconds * 10) / 10 };
}
