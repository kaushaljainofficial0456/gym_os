/**
 * SELECT -- a dropdown that looks like the rest of the app.
 *
 * The native <select> drew its option list in the operating system's own
 * style: a white Windows list on a dark app, small type, no spacing, no
 * selected mark. This is the iOS-style replacement: a field-shaped button,
 * and a rounded list with roomy rows and a checkmark.
 *
 * Behaviour follows the ARIA "select-only combobox" pattern:
 *  - the button keeps focus the whole time (aria-activedescendant points at
 *    the highlighted option), so a dialog's focus trap never fights it;
 *  - Arrow keys, Home/End, Enter/Space, Escape and type-to-jump work;
 *  - Escape closes only the list (preventDefault tells a surrounding dialog
 *    the key was handled -- see useDialog);
 *  - the list is portalled to <body> and positioned against the button, so
 *    no overflow:hidden card or transformed ancestor clips or misplaces it,
 *    and it opens upward when there is no room below.
 *
 * Props: value, onChange(value), options [{ value, label, hint? }],
 * placeholder, aria-label / id (label it like any field), disabled,
 * className (applied to the button, e.g. widths).
 */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './select.css';

export default function Select({
  value, onChange, options = [], placeholder = 'Choose…', disabled = false,
  className = '', id, 'aria-label': ariaLabel, 'aria-labelledby': ariaLabelledby, name,
}) {
  const autoId = useId();
  const listId = `${id || autoId}-list`;
  const btnRef = useRef(null);
  const listRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState(null);
  const typed = useRef({ text: '', at: 0 });

  const selectedIndex = useMemo(() => options.findIndex((o) => String(o.value) === String(value ?? '')), [options, value]);
  const current = selectedIndex >= 0 ? options[selectedIndex] : null;

  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const gap = 6;
    const want = Math.min(320, options.length * 46 + 12);
    const below = window.innerHeight - b.bottom - gap - 8;
    const above = b.top - gap - 8;
    const up = below < Math.min(want, 200) && above > below;
    const width = Math.max(b.width, 200);
    const left = Math.min(Math.max(8, b.left), window.innerWidth - width - 8);
    setPos({ left, width, maxHeight: Math.max(140, Math.min(want, up ? above : below)), ...(up ? { bottom: window.innerHeight - b.top + gap } : { top: b.bottom + gap }) });
  }, [options.length]);

  const show = () => { if (disabled) return; place(); setActive(selectedIndex >= 0 ? selectedIndex : 0); setOpen(true); };
  const hide = (refocus = true) => { setOpen(false); if (refocus) btnRef.current?.focus({ preventScroll: true }); };
  const choose = (i) => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (String(o.value) !== String(value ?? '')) onChange?.(o.value);
    hide();
  };

  useLayoutEffect(() => { if (open) place(); }, [open, place]);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (btnRef.current?.contains(e.target) || listRef.current?.contains(e.target)) return;
      hide(false);
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);
  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]);

  const step = (from, dir) => {
    for (let k = 1; k <= options.length; k += 1) {
      const i = (from + dir * k + options.length * 2) % options.length;
      if (!options[i]?.disabled) return i;
    }
    return from;
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    const k = e.key;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(k)) { e.preventDefault(); show(); }
      return;
    }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); return; }
    if (k === 'Tab') { hide(false); return; }
    if (k === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); return; }
    if (k === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); return; }
    if (k === 'Home') { e.preventDefault(); setActive(step(-1, 1)); return; }
    if (k === 'End') { e.preventDefault(); setActive(step(options.length, -1)); return; }
    if (k === 'Enter' || k === ' ') { e.preventDefault(); choose(active); return; }
    if (k.length === 1 && /\S/.test(k)) {
      const now = Date.now();
      typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + k.toLowerCase(), at: now };
      const t = typed.current.text;
      const i = options.findIndex((o) => String(o.label).toLowerCase().startsWith(t));
      if (i >= 0) setActive(i);
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        id={id}
        name={name}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        disabled={disabled}
        className={`input sel-trigger ${className}`}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span className={`sel-value${current ? '' : ' is-placeholder'}`}>{current ? current.label : placeholder}</span>
        <svg className="sel-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
      </button>
      {open && pos && createPortal(
        <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="sel-list"
          style={{ left: pos.left, width: pos.width, maxHeight: pos.maxHeight, top: pos.top, bottom: pos.bottom }}>
          {options.map((o, i) => {
            const isSel = i === selectedIndex;
            return (
              <li key={String(o.value)} id={`${listId}-${i}`} data-i={i} role="option" aria-selected={isSel} aria-disabled={o.disabled || undefined}
                className={`sel-option${i === active ? ' is-active' : ''}${isSel ? ' is-selected' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}>
                <span className="min-w-0">
                  <span className="sel-label">{o.label}</span>
                  {o.hint && <span className="sel-hint">{o.hint}</span>}
                </span>
                {isSel && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" /></svg>
                )}
              </li>
            );
          })}
        </ul>,
        document.body,
      )}
    </>
  );
}
