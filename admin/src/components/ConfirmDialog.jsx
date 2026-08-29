import { useEffect, useRef, useState } from 'react';

/**
 * A confirmation modal for dangerous admin actions. `confirmText`, when
 * given, requires the operator to type it exactly before the confirm
 * button enables -- for the genuinely destructive/financial actions
 * (suspend, refund) where a single misclick must never be enough.
 * Without `confirmText` it's a plain confirm/cancel dialog.
 */
export default function ConfirmDialog({
  open, title, description, confirmLabel = 'Confirm', confirmText, danger = true,
  busy = false, onConfirm, onCancel, children,
}) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => (confirmText ? inputRef.current : null)?.focus(), 30);
    return () => { document.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [open, confirmText, busy, onCancel]);

  if (!open) return null;
  const canConfirm = !confirmText || typed === confirmText;

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal-panel" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
        <h3 id="confirm-dialog-title">{title}</h3>
        {description && <p className="modal-desc">{description}</p>}
        {children}
        {confirmText && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Type <strong>{confirmText}</strong> to confirm</label>
            <input ref={inputRef} className="input" value={typed} onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmText} autoComplete="off" />
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className={`btn ${danger ? 'danger' : ''}`} onClick={onConfirm} disabled={busy || !canConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
