/**
 * RECORDINGS -- your own voice, for prerecorded calls.
 *
 * Upload an MP3/M4A/WAV/OGG/WebM file or record one here. The page turns it
 * into phone audio (8 kHz, mono) before it leaves the browser -- the server
 * checks it again -- so what you preview is exactly what members hear.
 * Every call adds the fixed "automated call from your gym" notice before it
 * and the keypad menu after it.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api.js';
import { Card, Modal, PageSkeleton } from '../../UI.jsx';
import Select from '../../Select.jsx';
import Icon from '../../Icon.jsx';
import { Field, SectionHead, Tag, when, useApi } from './shared.jsx';

const RATE = 8000;
const MAX_SECS = 120;

/** Any audio the browser can decode -> { blob: WAV 8 kHz mono 16-bit, seconds }. */
export async function toPhoneWav(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !window.OfflineAudioContext) throw new Error('This browser cannot convert audio. Try Chrome, Edge or Safari.');
  const ctx = new Ctx();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); } catch { throw new Error('That file could not be read as audio.'); } finally { ctx.close?.(); }
  if (decoded.duration < 1) throw new Error('The recording is shorter than a second.');
  if (decoded.duration > MAX_SECS) throw new Error(`Keep it under 2 minutes (this one is ${Math.round(decoded.duration)} seconds).`);
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * RATE), RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const out = (await offline.startRendering()).getChannelData(0);
  let peak = 0;
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
  if (peak < 0.01) throw new Error('The recording is silent. Check the microphone and try again.');
  const buf = new ArrayBuffer(44 + out.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, out.length * 2, true);
  for (let i = 0; i < out.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, out[i])) * 32767, true);
  return { blob: new Blob([buf], { type: 'audio/wav' }), seconds: decoded.duration };
}

export default function Recordings({ ctx }) {
  const list = useApi('/followups/recordings');
  const [adding, setAdding] = useState(false);
  if (list.loading) return <PageSkeleton label="Loading recordings" />;
  const rows = list.data?.recordings || [];
  const update = async (r, body, done) => {
    try { await api(`/followups/recordings/${r.id}`, { method: 'PUT', body: JSON.stringify(body) }); list.reload(); ctx.notify(done); } catch (e) { ctx.notify(e.message, 'error'); }
  };
  return (
    <>
      <SectionHead title="Recordings" action={<button type="button" className="btn-primary" onClick={() => setAdding(true)}>+ Add a recording</button>} />
      <p className="text-[14px] -mt-1" style={{ color: 'var(--mute)' }}>
        Your own voice for prerecorded calls: a renewal reminder, a holiday closure, an event. Each call adds the fixed notice before it and the keypad menu after it.
      </p>
      {rows.length === 0 ? <Card className="p-5 text-[15px]" style={{ color: 'var(--mute)' }}>No recordings yet. Upload a file or record one in your browser.</Card> : (
        <Card>
          {rows.map((r) => (
            <div key={r.id} className="cm-row flex-wrap">
              <div className="flex-1 min-w-[180px]">
                <div className="font-semibold" style={{ color: 'var(--ink)' }}>{r.name}</div>
                <div className="text-[13px]" style={{ color: 'var(--mute)' }}>{Math.round(r.duration_secs)} seconds · {(ctx.languages.find((l) => l.code === r.language)?.name) || r.language} · added {when(r.created_at)}</div>
              </div>
              <audio controls preload="none" src={`/api/followups/recordings/${r.id}/audio`} aria-label={`Play ${r.name}`} style={{ height: 36, maxWidth: '100%' }} />
              <div className="flex gap-1.5">
                <button type="button" className="btn btn-sm" onClick={() => { const n = window.prompt('New name', r.name); if (n && n.trim() !== r.name) update(r, { name: n.trim() }, 'Renamed'); }}>Rename</button>
                <button type="button" className="btn btn-sm" onClick={() => update(r, { status: 'archived' }, 'Archived')}>Archive</button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {adding && <AddRecording ctx={ctx} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); list.reload(); ctx.notify('Recording saved'); }} />}
    </>
  );
}

function AddRecording({ ctx, onClose, onSaved }) {
  const [name, setName] = useState('');
  const [language, setLanguage] = useState(ctx.settings.language || 'en');
  const [audio, setAudio] = useState(null);            // { blob, seconds, url, file }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [rec, setRec] = useState(null);                // { recorder, started, stream }
  const [, tick] = useState(0);
  const chunks = useRef([]);
  useEffect(() => () => { if (audio?.url) URL.revokeObjectURL(audio.url); }, [audio]);
  useEffect(() => { if (!rec) return undefined; const t = setInterval(() => tick((n) => n + 1), 500); return () => clearInterval(t); }, [rec]);

  const take = async (file, label) => {
    setErr(''); setBusy(true);
    try {
      const out = await toPhoneWav(file);
      setAudio({ ...out, url: URL.createObjectURL(out.blob), file: label });
      if (!name) setName(label.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 80));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const startRecording = async () => {
    setErr('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunks.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.current.push(e.data); };
      recorder.onstop = () => { stream.getTracks().forEach((t) => t.stop()); take(new Blob(chunks.current, { type: recorder.mimeType }), 'Recording'); };
      recorder.start();
      const started = Date.now();
      setRec({ recorder, started });
      setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); setRec(null); }, MAX_SECS * 1000);
    } catch { setErr('The microphone is not available. Allow it in the browser, or upload a file instead.'); }
  };
  const stopRecording = () => { rec?.recorder.stop(); setRec(null); };
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const q = new URLSearchParams({ name: name.trim(), language, file: audio.file || '' });
      await api(`/followups/recordings?${q}`, { method: 'POST', body: audio.blob, headers: { 'Content-Type': 'audio/wav' } });
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const secs = rec ? Math.floor((Date.now() - rec.started) / 1000) : 0;
  return (
    <Modal open onClose={onClose} title="Add a recording"
      footer={<div className="flex justify-end gap-2 w-full"><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={!audio || busy || name.trim().length < 2} onClick={save}>{busy ? 'Working…' : 'Save'}</button></div>}>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <label className="btn justify-center cursor-pointer" style={{ minHeight: 48 }}>
            <Icon name="plus" size={16} /> Upload a file
            <input type="file" className="sr-only" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.webm" onChange={(e) => { const f = e.target.files?.[0]; if (f) take(f, f.name); e.target.value = ''; }} />
          </label>
          {rec ? (
            <button type="button" className="btn justify-center" style={{ minHeight: 48, color: 'var(--bad)' }} onClick={stopRecording}><Icon name="pause" size={16} /> Stop · {secs}s</button>
          ) : (
            <button type="button" className="btn justify-center" style={{ minHeight: 48 }} onClick={startRecording} disabled={busy}><Icon name="mic" size={16} /> Record in the browser</button>
          )}
        </div>
        {audio && (
          <div className="rounded-2xl p-3 space-y-2" style={{ background: 'rgb(var(--tint-rgb) / .05)' }}>
            <div className="flex items-center gap-2 flex-wrap"><Tag tone="good">Ready</Tag><span className="text-[13px]" style={{ color: 'var(--mute)' }}>{Math.round(audio.seconds)} seconds, as members will hear it on the phone</span></div>
            <audio controls src={audio.url} className="w-full" aria-label="Preview the recording" />
          </div>
        )}
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Name"><input className="input w-full" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali closure" /></Field>
          <Field label="Language it is in">
            <Select aria-label="Language" value={language} onChange={setLanguage} options={ctx.languages.map((l) => ({ value: l.code, label: l.name }))} />
          </Field>
        </div>
        <p className="text-[13px]" style={{ color: 'var(--mute)' }}>Up to 2 minutes. Speak clearly; phone lines carry less detail than your speakers.</p>
        {err && <div role="alert" className="text-[14px] font-semibold" style={{ color: 'var(--bad)' }}>{err}</div>}
      </div>
    </Modal>
  );
}
