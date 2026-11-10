// ============================================================
// SARVAM -- Indian-language speech (Bulbul), a SPEECH adapter.
//
// POST https://api.sarvam.ai/text-to-speech, header api-subscription-key;
// body { text, language_code ('hi-IN'...), model, speaker,
// speech_sample_rate: 8000, output_audio_codec: 'wav' } -> { audios:
// [base64 WAV] }. Speakers are a fixed list per model; there is no voice
// design or cloning. Verified against docs.sarvam.ai (2026-11).
// ============================================================
const KEY = () => String(process.env.SARVAM_API_KEY || '').trim();
const MODEL = () => String(process.env.SARVAM_TTS_MODEL || 'bulbul:v3').trim();
const LANG = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN', ta: 'ta-IN', te: 'te-IN', mr: 'mr-IN', bn: 'bn-IN', gu: 'gu-IN', ml: 'ml-IN', pa: 'pa-IN' };

// bulbul:v3 speakers (case-sensitive). Gender from Sarvam's voice guide.
const V3 = {
  female: ['ritu', 'priya', 'neha', 'pooja', 'simran', 'kavya', 'ishita', 'shreya', 'roopa', 'tanya', 'shruti', 'suhani', 'kavitha', 'rupali'],
  male: ['shubh', 'aditya', 'rahul', 'rohan', 'amit', 'dev', 'ratan', 'varun', 'manan', 'sumit', 'kabir', 'aayan', 'ashutosh', 'advait', 'anand', 'tarun', 'sunny', 'mani', 'gokul', 'vijay', 'mohit', 'rehan', 'soham'],
};
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export const speech = {
  id: 'sarvam',
  label: 'Sarvam',
  languages: Object.keys(LANG),
  features: { library: true, design: false, clone: false },
  configured: () => !!KEY(),
  async listVoices() {
    return [...V3.female.map((v) => ({ voice_id: v, name: cap(v), gender: 'female' })), ...V3.male.map((v) => ({ voice_id: v, name: cap(v), gender: 'male' }))]
      .map((v) => ({ ...v, accent: 'Indian', description: 'Sarvam Bulbul · speaks every Indian language here', preview_url: null }));
  },
  async synthesize({ voiceId, text, language }) {
    if (!KEY()) throw Object.assign(new Error('Sarvam is not configured'), { status: 503 });
    const res = await fetch('https://api.sarvam.ai/text-to-speech', {
      method: 'POST',
      headers: { 'api-subscription-key': KEY(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text.slice(0, 2500), language_code: LANG[language] || 'en-IN', model: MODEL(), speaker: voiceId, speech_sample_rate: 8000, output_audio_codec: 'wav' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw Object.assign(new Error(`Making the voice message failed (${res.status})${j?.error?.message ? `: ${j.error.message}` : ''}`), { status: res.status === 429 ? 429 : 502 });
    }
    const j = await res.json();
    const parts = (j.audios || []).map((b) => Buffer.from(b, 'base64'));
    if (!parts.length) throw Object.assign(new Error('Sarvam returned no audio'), { status: 502 });
    return { audio: parts.length === 1 ? parts[0] : joinWav(parts), model: MODEL() };
  },
};

/** Concatenate WAV chunks with the same format (Sarvam splits long text). */
function joinWav(parts) {
  const header = parts[0].subarray(0, 44);
  const data = Buffer.concat(parts.map((p) => p.subarray(44)));
  const out = Buffer.concat([Buffer.from(header), data]);
  out.writeUInt32LE(36 + data.length, 4);
  out.writeUInt32LE(data.length, 40);
  return out;
}
