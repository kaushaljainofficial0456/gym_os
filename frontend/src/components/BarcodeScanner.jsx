/**
 * BARCODE SCANNER — camera scan with a typed fallback.
 *
 * NO NEW DEPENDENCY, ON PURPOSE. The usual choice here is ZXing or
 * html5-qrcode, which costs 200-300 kB of JavaScript on a bundle already
 * carrying three.js. Chrome on Android — which is the overwhelming
 * majority of this app's users — ships `BarcodeDetector` natively, so the
 * scan path is free where it works.
 *
 * It genuinely does NOT work everywhere: iOS Safari has no BarcodeDetector
 * at all. That is why manual entry is not a hidden fallback but a
 * first-class field, always visible. A user who cannot scan can still type
 * the 13 digits off the pack, which is the whole point of the feature.
 *
 * The camera stream is stopped on every exit path — closing, a successful
 * scan, or unmount. A live getUserMedia track keeps the phone's camera
 * indicator on and drains battery, and it is the kind of leak nobody
 * notices in development because the tab is never open for long.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Pressable } from '../design/index.js';

const supportsDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

export default function BarcodeScanner({ open, onClose, onScanned }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);

  const stop = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  const lookup = async (code) => {
    setBusy(true);
    setStatus('Looking it up…');
    try {
      const item = await api(`/intel/foods/barcode/${encodeURIComponent(code)}`);
      stop();
      onScanned(item);
    } catch (e) {
      // A miss is expected: Open Food Facts is crowd-sourced, so a real
      // product can simply be unindexed. Say so plainly and keep going.
      setStatus(e.status === 404 || /not recognis/i.test(e.message || '')
        ? `Barcode ${code} isn’t in the database yet — search by name instead.`
        : (e.message || 'Lookup failed'));
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!open) { stop(); setStatus(''); setManual(''); return undefined; }
    if (!supportsDetector) {
      setStatus('This browser can’t scan — type the number under the barcode.');
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('Point at the barcode');

        const detector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'],
        });
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found?.length) {
              const code = found[0].rawValue;
              if (code) { await lookup(code); return; }
            }
          } catch { /* a frame that fails to decode is normal */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setStatus('Camera unavailable — type the number under the barcode.');
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [open]);

  useEffect(() => stop, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
         style={{ background: 'rgb(var(--bg-rgb) / .92)' }}>
      <div className="card w-full max-w-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Scan barcode</div>
          <button onClick={() => { stop(); onClose(); }} aria-label="Close scanner" style={{ color: 'var(--mute)' }}>✕</button>
        </div>

        {supportsDetector && (
          <div className="relative rounded-xl overflow-hidden mb-3" style={{ background: '#000', aspectRatio: '4/3' }}>
            <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
            {/* A framing guide, so the user knows where to aim. */}
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="w-[70%] h-[38%] rounded-lg"
                   style={{ border: '2px solid var(--accent)', boxShadow: '0 0 0 9999px rgb(0 0 0 / .35)' }} />
            </div>
          </div>
        )}

        {!!status && (
          <div className="text-[11px] mb-3" style={{ color: 'var(--mute)' }}>{status}</div>
        )}

        <label className="block">
          <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>
            Or type the number
          </span>
          <div className="flex gap-2 mt-1">
            <input value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, ''))}
                   inputMode="numeric" placeholder="8901234567895"
                   aria-label="Barcode number"
                   className="input flex-1 !py-2 tabular-nums" />
            <Pressable onClick={() => manual.length >= 8 && lookup(manual)}
                       disabled={manual.length < 8 || busy}
                       className="btn-primary !px-4 !py-2 text-[12px] font-bold">
              {busy ? '…' : 'Find'}
            </Pressable>
          </div>
        </label>
      </div>
    </div>
  );
}
