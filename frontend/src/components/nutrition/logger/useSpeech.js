import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speak a meal instead of typing it ("do roti, ek katori dal aur chai").
 *
 * The browser's own speech recognition (Chrome/Edge/Safari) -- no audio
 * leaves the device through this app, and no vendor key is involved. Where
 * it is unavailable (Firefox, some WebViews) `supported` is false and the
 * mic is simply not offered; typing works everywhere.
 *
 * en-IN, because that is how the food words are actually pronounced here:
 * en-US hears "dal" as "doll" and "poha" as "power".
 */
const Recognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

export function useSpeech({ onFinal, lang = 'en-IN' } = {}) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const finalRef = useRef('');
  const onFinalRef = useRef(onFinal);
  useEffect(() => { onFinalRef.current = onFinal; });

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* already stopped */ }
  }, []);

  const start = useCallback(() => {
    if (!Recognition || listening) return;
    setError(null);
    setInterim('');
    finalRef.current = '';
    const rec = new Recognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let fin = '';
      let mid = '';
      for (let i = 0; i < e.results.length; i += 1) {
        const r = e.results[i];
        if (r.isFinal) fin += r[0].transcript; else mid += r[0].transcript;
      }
      finalRef.current = fin;
      setInterim((fin + ' ' + mid).trim());
    };
    rec.onerror = (e) => {
      // "no-speech" and "aborted" are a person deciding not to speak.
      if (e.error && e.error !== 'no-speech' && e.error !== 'aborted') {
        setError(e.error === 'not-allowed' ? 'Microphone access is blocked for this site.' : 'Could not hear that — try again or type it.');
      }
    };
    rec.onend = () => {
      setListening(false);
      const text = finalRef.current.trim();
      if (text) onFinalRef.current?.(text);
      recRef.current = null;
    };
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setError('Could not start the microphone.');
    }
  }, [lang, listening]);

  useEffect(() => () => { try { recRef.current?.abort(); } catch { /* gone */ } }, []);

  return { supported: !!Recognition, listening, interim, error, start, stop };
}
