import { createContext, useCallback, useContext, useRef, useState } from 'react';

// Success/error feedback for admin mutations (refund, suspend, priority
// change, assignment...) -- these actions previously either failed
// silently or only showed an inline .error-text with no positive
// confirmation at all.
const ToastCtx = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback((message, tone = 'success', duration = 3200) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => dismiss(id), duration);
  }, [dismiss]);

  const toast = {
    success: (m) => show(m, 'success'),
    error: (m) => show(m, 'error', 4200),
  };

  return (
    <ToastCtx.Provider value={toast}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span className="dot" aria-hidden="true" />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
