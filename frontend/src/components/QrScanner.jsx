/**
 * QR SCANNER — camera scan with a typed/pasted fallback, for gym
 * enrollment QR codes (client + trainer join). Mirrors
 * BarcodeScanner.jsx's approach exactly (same reasoning applies: native
 * `BarcodeDetector` costs nothing extra, and manual entry is a
 * first-class field, not a hidden fallback, because iOS Safari has no
 * BarcodeDetector at all) -- kept as its own component rather than
 * generalizing BarcodeScanner because the payload shape is different
 * (an opaque `<id>.<secret>` string, not a numeric barcode) and this
 * scanner has no lookup step of its own: it just hands the raw scanned
 * string back to the caller, which is the one that knows what to do
 * with an enrollment QR payload.
 */
import { useEffect, useRef, useState } from 'react';

const supportsDetector = typeof window !== 'undefined' && 'BarcodeDetector' in window;

export default function QrScanner({ open, onClose, onScanned }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(null);
  const [status, setStatus] = useState('');
  const [manual, setManual] = useState('');

  const stop = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  };

  useEffect(() => {
    if (!open) { stop(); setStatus(''); setManual(''); return undefined; }
    if (!supportsDetector) {
      setStatus('This browser can’t scan — paste the code your gym shared instead.');
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('Point at the QR code');

        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (cancelled || !videoRef.current) return;
          try {
            const found = await detector.detect(videoRef.current);
            if (found?.length && found[0].rawValue) {
              const value = found[0].rawValue;
              stop();
              onScanned(value);
              return;
            }
          } catch { /* a frame that fails to decode is normal */ }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch {
        setStatus('Camera unavailable — paste the code your gym shared instead.');
      }
    })();

    return () => { cancelled = true; stop(); };
  }, [open]);

  useEffect(() => stop, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
         style={{ background: 'rgb(var(--bg-rgb) / .92)' }}
         onClick={(e) => e.stopPropagation()}>
      <div className="card w-full max-w-sm p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[11px] uppercase tracking-[.18em]" style={{ color: 'var(--faint)' }}>Scan gym QR code</div>
          <button onClick={() => { stop(); onClose(); }} aria-label="Close scanner" style={{ color: 'var(--mute)' }}>✕</button>
        </div>

        {supportsDetector && (
          <div className="relative rounded-xl overflow-hidden mb-3" style={{ background: '#000', aspectRatio: '1/1' }}>
            <video ref={videoRef} playsInline muted className="w-full h-full object-cover" />
            <div className="absolute inset-0 grid place-items-center pointer-events-none">
              <div className="w-[68%] h-[68%] rounded-lg" style={{ border: '2px solid var(--accent)', boxShadow: '0 0 0 9999px rgb(0 0 0 / .35)' }} />
            </div>
          </div>
        )}

        {!!status && <div className="text-[11px] mb-3" style={{ color: 'var(--mute)' }}>{status}</div>}

        <label className="block">
          <span className="text-[9px] uppercase tracking-[.16em]" style={{ color: 'var(--faint)' }}>Or paste the code</span>
          <div className="flex gap-2 mt-1">
            <input value={manual} onChange={(e) => setManual(e.target.value.trim())}
                   placeholder="enr_xxxxxxxx.xxxxxxxxxxxxxxxxxxxxxxxx"
                   aria-label="QR code payload"
                   className="input flex-1 !py-2 text-[12px]" />
            <button onClick={() => manual && (stop(), onScanned(manual))} disabled={!manual}
                    className="btn-primary !px-4 !py-2 text-[12px] font-bold">
              Join
            </button>
          </div>
        </label>
      </div>
    </div>
  );
}
