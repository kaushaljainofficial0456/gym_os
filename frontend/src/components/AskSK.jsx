import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Icon from './Icon.jsx';

// Web Speech API — speech recognition when the browser supports it.
// (Chrome/Edge/Safari ship it; Firefox needs a flag.) Everything else
// stays typed. The mic only fills the input — nothing is committed
// without the normal review + confirm flow.
const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition || null)
  : null;

const HINTS = [
  '220g paneer',
  '2 rotis + 150g rice',
  '100g oats + 250ml milk',
  'Bench press 60x8, 65x6, 65x5',
  '3 sets lat pulldown at 50kg for 10',
  'Show dumbbell exercises for chest',
  '4 day hypertrophy, no barbell squats',
  'Only dumbbells for shoulders'
];

// Cheap intent routing: program-ish → generate; else food → workout → exercises → error.
function isProgramRequest(text) {
  const t = text.toLowerCase();
  const hasDays = /\d\s*-?\s*day/.test(t) || /(\d)\s+day/.test(t);
  const programy = /(workout|plan|program|split|schedule|routine)/.test(t) && /(create|make|give|build|want|need|generate)/.test(t);
  return hasDays && programy;
}

function isExerciseRequest(text) {
  const t = text.toLowerCase();
  return /(show|find|list|search|need|what|exercises?)/.test(t) && !/(eat|ate|had|gram|kcal|g |kg|ml)/.test(t);
}

// Context questions → /intel/ask (protein eaten, calories, train today,
// last-week bench, plateau…). These run BEFORE food/workout parsing.
function isContextQuestion(text) {
  const t = text.toLowerCase();
  if (/scan|photo|label/.test(t)) return false;
  if (/(how much|how many|what did|what should|why|should i|left|remaining|today\?)/.test(t)) return true;
  if (/plateau|stuck|not (moving|changing)|protein.*(eat|today|left)|calor.*(eat|today|left)/.test(t)) return true;
  return false;
}

export default function AskSK({ onLogged }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('ask'); // ask | label | meal
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState(null); // { kind: 'food'|'workout'|'program'|'exercises'|'error', data }
  const [toast, setToast] = useState('');
  const [listening, setListening] = useState(false);
  // label scan state
  const fileRef = useRef(null);
  const mealRef = useRef(null);
  const recRef = useRef(null);
  const [scan, setScan] = useState(null); // { imagePath, fields, note, provenance }
  const [scanning, setScanning] = useState(false);
  const [meal, setMeal] = useState(null); // { items, range, confidence, note }
  const [mealBusy, setMealBusy] = useState(false);

  const showToast = (m) => { setToast(m); setTimeout(() => setToast(''), 2400); };

  // stop any active recognition when the modal closes or the component unmounts
  useEffect(() => () => { try { recRef.current?.stop(); } catch { /* already stopped */ } }, []);

  const stopVoice = () => {
    try { recRef.current?.stop(); } catch { /* noop */ }
    setListening(false);
  };

  const toggleVoice = () => {
    if (listening) return stopVoice();
    if (!SR) return showToast('Speech input isn\'t supported in this browser — type it instead.');
    try {
      const rec = new SR();
      rec.lang = 'en-IN';              // Indian English fits the food/workout vocabulary
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        let spoken = '';
        for (let i = e.resultIndex; i < e.results.length; i++) spoken += e.results[i][0].transcript;
        setText((prev) => (prev.trim() ? prev.trim() + ' ' : '') + spoken.trim());
      };
      rec.onerror = (e) => {
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
          showToast('Microphone access was denied — allow it in your browser to use voice.');
        } else if (e.error !== 'aborted' && e.error !== 'no-speech') {
          showToast('Voice input had a problem — keep typing instead.');
        }
        setListening(false);
      };
      rec.onend = () => setListening(false);
      recRef.current = rec;
      rec.start();
      setListening(true);
      showToast('Listening… speak naturally — “220g paneer” or “bench press 60 kilo 8 reps”.');
    } catch {
      setListening(false);
      showToast('Couldn\'t start voice input in this browser.');
    }
  };

  const understand = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true); setView(null);
    try {
      if (isContextQuestion(t)) {
        const data = await api('/intel/ask', { method: 'POST', body: JSON.stringify({ text: t }) });
        setView({ kind: 'context', data });
      } else if (isProgramRequest(t)) {
        const days = Number((t.toLowerCase().match(/(\d+)\s*-?\s*day/) || [])[1]) || 3;
        const eq = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight', 'bands', 'kettlebell', 'pull_up_bar', 'bench', 'smith', 'leg_press']
          .filter((e) => t.toLowerCase().includes(e.replace(/_/g, ' ')) || t.toLowerCase().includes(e));
        const goal = t.toLowerCase().includes('hypertrophy') ? 'hypertrophy'
          : t.toLowerCase().includes('strength') ? 'strength'
          : t.toLowerCase().includes('fat') ? 'fat loss'
          : t.toLowerCase().includes('beginner') ? 'beginner' : 'general';
        const exclude = t.toLowerCase().includes('no barbell squats') || t.toLowerCase().includes('can\'t squat') || t.toLowerCase().includes('no squats') ? ['squat'] : [];
        const data = await api('/intel/generate-workout', { method: 'POST', body: JSON.stringify({ goal, days, equipment: eq, exclude }) });
        setView({ kind: 'program', data });
      } else if (isExerciseRequest(t)) {
        const data = await api(`/intel/exercises?q=${encodeURIComponent(t)}`);
        setView({ kind: 'exercises', data });
      } else {
        // food first; fall through to workout parsing if food resolves nothing
        try {
          const parsed = await api('/intel/parse-food', { method: 'POST', body: JSON.stringify({ text: t }) });
          const resolvedAny = (parsed.items || []).length > 0;
          if (resolvedAny) { setView({ kind: 'food', data: parsed }); return; }
          // nothing resolvable as food — try workout log
          const w = await api('/intel/parse-workout', { method: 'POST', body: JSON.stringify({ text: t }) });
          setView({ kind: 'workout', data: w });
        } catch (e1) {
          try {
            const w = await api('/intel/parse-workout', { method: 'POST', body: JSON.stringify({ text: t }) });
            setView({ kind: 'workout', data: w });
          } catch (e2) {
            setView({ kind: 'error', data: { message: e2.message || e1.message || 'Could not understand that. Try "220g paneer" or "Bench press 60kg 8 reps".' } });
          }
        }
      }
    } catch (e) {
      setView({ kind: 'error', data: { message: e.message || 'Something went wrong' } });
    }
    setBusy(false);
  };

  const addFoods = async () => {
    const entries = view.data.items.map((i) => ({ food_id: i.food_id, quantity: i.quantity, unit: i.unit }));
    if (!entries.length) return showToast('Nothing to add');
    try {
      const r = await api('/intel/confirm-food', { method: 'POST', body: JSON.stringify({ entries }) });
      showToast(`Logged ${r.committed.length} item${r.committed.length > 1 ? 's' : ''} ✓`);
      setView(null); setText('');
      onLogged && onLogged();
    } catch (e) { showToast(e.message); }
  };

  const logWorkout = async () => {
    const v = view.data;
    try {
      await api('/intel/confirm-workout', { method: 'POST', body: JSON.stringify({
        exercise_id: v.resolved?.id || null,
        exercise_name: v.exercise,
        sets: v.sets.map((s) => ({ weight: s.weight, reps: s.reps }))
      }) });
      showToast(`${v.exercise} logged (${v.totalSets} sets) ✓`);
      setView(null); setText('');
      onLogged && onLogged();
    } catch (e) { showToast(e.message); }
  };

  const scanLabel = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type)) return showToast('Please choose a PNG, JPEG, WebP or GIF image');
    if (file.size > 5 * 1024 * 1024) return showToast('Image too large (max 5 MB)');
    setScanning(true);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await api('/intel/label-scan', { method: 'POST', body: JSON.stringify({ image: b64 }) });
      // preview via authenticated fetch (uploads are private now)
      r.previewUrl = await authedImage(r.imagePath);
      setScan(r);
    } catch (e) { showToast(e.message); }
    setScanning(false);
  };

  const saveLabel = async () => {
    if (!scan?.fields?.name?.trim()) return showToast('Product name required');
    try {
      await api('/intel/foods/label', { method: 'POST', body: JSON.stringify({ ...scan.fields, imagePath: scan.imagePath }) });
      showToast('Saved to My Foods (LABEL SCANNED)');
      setScan(null); setTab('ask');
      onLogged && onLogged();
    } catch (e) { showToast(e.message); }
  };

  const setF = (k, v) => setScan((s) => ({ ...s, fields: { ...s.fields, [k]: v } }));

  // Authenticated image preview: /uploads/* now requires the JWT, and an
  // <img src> can't send headers — fetch with auth and show a blob URL.
  const authedImage = async (pathname) => {
    try {
      const res = await fetch('/api' + pathname, { headers: { Authorization: 'Bearer ' + localStorage.getItem('pos_token') }, credentials: 'include' });
      if (!res.ok) throw new Error('image fetch failed');
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch { return null; }
  };

  const estimateMeal = async (file) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp)$/.test(file.type)) return showToast('Please choose a PNG, JPEG or WebP image');
    if (file.size > 5 * 1024 * 1024) return showToast('Image too large (max 5 MB)');
    setMealBusy(true);
    try {
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      const r = await api('/intel/meal-photo', { method: 'POST', body: JSON.stringify({ image: b64 }) });
      setMeal(r);
    } catch (e) { showToast(e.message); }
    setMealBusy(false);
  };

  return (
    <>
      {/* Ask SK OS bar */}
      <button onClick={() => setOpen(true)}
        className="card w-full !p-3.5 flex items-center gap-3 text-left transition-all hover:border-gold/40 group">
        <span className="w-9 h-9 rounded-xl grid place-items-center text-base bg-gradient-to-br from-ember/30 to-gold/20 border border-ember/30 group-hover:shadow-glow transition-shadow">⚡</span>
        <span className="flex-1 min-w-0">
          <span className="block font-grotesk text-sm font-semibold">Ask SK OS</span>
          <span className="text-[11px] text-mute truncate">Type food, workouts or questions — “220g paneer” · “Bench press 60x8” · “4 day hypertrophy”</span>
        </span>
        <span className="chip border-gold/40 text-gold shrink-0">Try it</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm grid place-items-end sm:place-items-center p-0 sm:p-4">
          <div className="card w-full sm:max-w-lg h-[92vh] sm:h-auto sm:max-h-[86vh] flex flex-col overflow-hidden rounded-b-none sm:rounded-2xl">
            {/* header */}
            <div className="p-4 border-b border-line/60 flex items-center justify-between">
              <div>
                <div className="font-grotesk font-bold flex items-center gap-2"><span>⚡ Ask SK OS</span>
                  <span className="chip border-line !px-1.5 !py-0 text-[8px] text-mute">intelligence</span>
                </div>
                <div className="text-[10px] text-mute mt-0.5">Type it, or scan a nutrition label — nothing is saved without your confirmation.</div>
              </div>
              <button className="text-mute hover:text-ink text-lg" onClick={() => { stopVoice(); setOpen(false); setView(null); setText(''); }} aria-label="Close">✕</button>
            </div>

            {/* tabs */}
            <div className="flex gap-1.5 px-4 pt-3">
              <button className={`chip ${tab === 'ask' ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent' : ''}`} onClick={() => setTab('ask')}>Ask</button>
              <button className={`chip ${tab === 'label' ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent' : ''}`} onClick={() => setTab('label')}>Scan label</button>
              <button className={`chip ${tab === 'meal' ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent' : ''}`} onClick={() => setTab('meal')}>Meal photo</button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {tab === 'ask' ? (
                <>
                  <div className="relative">
                    <textarea rows={2} className="input resize-none pr-11" placeholder="e.g. 220g paneer + 2 rotis + 150g rice"
                      value={text} onChange={(e) => setText(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); understand(); } }} />
                    <button
                      onClick={toggleVoice}
                      aria-label={listening ? 'Stop voice input' : 'Speak your food or workout'}
                      title={SR ? (listening ? 'Stop listening' : 'Speak') : 'Speech not supported here'}
                      className={`absolute right-2 top-2 w-8 h-8 rounded-lg grid place-items-center text-sm border transition-all
                        ${listening
                          ? 'bg-gradient-to-br from-ember to-gold text-bg border-transparent shadow-glow anim-pulse-soft'
                          : 'bg-bg/60 border-line text-mute hover:text-gold hover:border-gold/40'}`}>
                      {listening ? '◉' : <Icon name="mic" size={16} />}
                    </button>
                  </div>
                  {listening && (
                    <div className="flex items-center gap-2 text-[10px] text-gold anim-fadeUp">
                      <span className="w-1.5 h-1.5 rounded-full bg-gold anim-pulse-soft" />
                      Listening — tap ◉ when you're done, then review before adding.
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {HINTS.slice(0, 6).map((h) => (
                      <button key={h} className="chip border-line text-[10px] text-mute hover:text-gold hover:border-gold/40" onClick={() => { setText(h); }}>{h}</button>
                    ))}
                  </div>
                  <button className="btn-primary w-full" onClick={understand} disabled={busy || !text.trim()}>
                    {busy ? 'Understanding…' : '⚡ Understand'}
                  </button>

                  {/* food review */}
                  {view?.kind === 'food' && (
                    <div className="space-y-2.5 rounded-2xl border border-gold/30 bg-gold/5 p-3.5 anim-fadeUp">
                      <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">Review your entry</div>
                      {view.data.items.map((i, idx) => (
                        <div key={idx} className="rounded-xl border border-line bg-bg/60 px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="font-grotesk text-[13px] font-semibold">{i.name}</div>
                              <div className="text-[10px] text-mute">{i.quantity} {i.unit} · {i.macros.calories} kcal · P{i.macros.protein} C{i.macros.carbs} F{i.macros.fat}</div>
                            </div>
                            <div className="text-right shrink-0">
                              <span className={`chip !px-1.5 !py-0 text-[8px] ${i.provenance === 'ESTIMATED' ? 'text-warn border-warn/40' : 'text-good border-good/40'}`}>{i.provenance}</span>
                              <div className="text-[8px] text-faint mt-0.5">{i.confidence} · {i.sourceScope}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center justify-between rounded-xl bg-bg/60 border border-line px-3 py-2">
                        <span className="text-[11px] text-mute font-grotesk">TOTAL</span>
                        <span className="font-grotesk font-bold text-sm">{view.data.totals.calories} kcal · P{view.data.totals.protein} C{view.data.totals.carbs} F{view.data.totals.fat}</span>
                      </div>
                      {!!view.data.unresolved?.length && (
                        <div className="rounded-xl border border-warn/30 bg-warn/5 px-3 py-2 text-[11px] text-warn">
                          Couldn't confidently resolve: {view.data.unresolved.map((u) => u.name || u.raw).join(', ')} — those were skipped.
                        </div>
                      )}
                      {view.data.needsConfirmation && <div className="text-[10px] text-faint">Some values are estimated or approximate — check before adding.</div>}
                      <button className="btn-primary w-full !py-2.5 !text-xs" onClick={addFoods}>+ ADD TO TODAY</button>
                    </div>
                  )}

                  {/* context answer */}
                  {view?.kind === 'context' && (
                    <div className="space-y-2.5 rounded-2xl border border-violetx/30 bg-violetx/5 p-3.5 anim-fadeUp">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-violetx font-grotesk uppercase tracking-wider">SK Coach · {view.data.topic}</div>
                        <span className="chip border-line !px-1.5 !py-0 text-[8px] text-mute">{view.data.provenance}</span>
                      </div>
                      <div className="font-grotesk text-sm leading-relaxed">{view.data.summary}</div>
                      {view.data.followup && <div className="text-[11px] text-mute">{view.data.followup}</div>}
                      {view.data.detail?.remainingProtein != null && view.data.detail.remainingCalories != null && (
                        <div className="grid grid-cols-2 gap-2 mt-1">
                          <div className="rounded-xl border border-line bg-bg/60 px-3 py-2 text-center">
                            <div className="font-grotesk font-bold text-lg">{view.data.detail.remainingProtein}g</div>
                            <div className="text-[9px] text-mute uppercase tracking-wide">protein left</div>
                          </div>
                          <div className="rounded-xl border border-line bg-bg/60 px-3 py-2 text-center">
                            <div className="font-grotesk font-bold text-lg">{view.data.detail.remainingCalories}</div>
                            <div className="text-[9px] text-mute uppercase tracking-wide">kcal left</div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* workout review */}
                  {view?.kind === 'workout' && (
                    <div className="space-y-2.5 rounded-2xl border border-gold/30 bg-gold/5 p-3.5 anim-fadeUp">
                      <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">Review workout log</div>
                      <div className="font-grotesk text-sm font-bold">{view.data.exercise}</div>
                      {view.data.resolved && <div className="text-[10px] text-faint">Resolved → {view.data.resolved.name} · {view.data.resolved.primary_muscle} · {view.data.resolved.equipment}</div>}
                      <div className="space-y-1">
                        {view.data.sets.map((s, i) => (
                          <div key={i} className="flex justify-between rounded-lg border border-line bg-bg/60 px-3 py-1.5 text-[12px]">
                            <span className="text-mute font-grotesk">Set {s.set_number}</span>
                            <span className="font-grotesk font-semibold">{s.weight || 'BW'} kg × {s.reps} reps</span>
                          </div>
                        ))}
                      </div>
                      {!!view.data.candidates?.length && !view.data.resolved && (
                        <div className="text-[11px] text-warn">Did you mean: {view.data.candidates.slice(0, 4).map((c) => c.name).join(', ')}?</div>
                      )}
                      <button className="btn-primary w-full !py-2.5 !text-xs" onClick={logWorkout}>✓ LOG {view.data.totalSets} SET{view.data.totalSets > 1 ? 'S' : ''}</button>
                    </div>
                  )}

                  {/* program review */}
                  {view?.kind === 'program' && (
                    <div className="space-y-2.5 rounded-2xl border border-ember/30 bg-ember/5 p-3.5 anim-fadeUp">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-ember font-grotesk uppercase tracking-wider">Generated program</div>
                        <span className="chip border-ember/40 text-ember text-[8px]">TEMPLATE</span>
                      </div>
                      <div className="text-[11px] text-mute">{view.data.days}-day · {view.data.equipment.join(', ') || 'any'} · goal {view.data.goal}</div>
                      {view.data.exclusions?.length > 0 && <div className="text-[10px] text-warn">Excluded: {view.data.exclusions.join(', ')}</div>}
                      <div className="space-y-2">
                        {view.data.week.map((d) => (
                          <div key={d.day} className="rounded-xl border border-line bg-bg/60 p-2.5">
                            <div className="flex items-center justify-between">
                              <span className="font-grotesk text-[12px] font-bold">{d.day} · {d.name}</span>
                              <span className="text-[9px] text-faint">{d.exercises.length} exercises</span>
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {d.exercises.map((e) => (
                                <span key={e.exercise_id} className="chip border-line !px-1.5 !py-0 text-[9px]">{e.name}</span>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="text-[9px] text-faint">Built only from exercises in the SK OS database matching your equipment — it's a starting structure, not a prescription.</div>
                    </div>
                  )}

                  {/* exercise results */}
                  {view?.kind === 'exercises' && (
                    <div className="space-y-2 rounded-2xl border border-cyanx/25 bg-cyanx/5 p-3.5 anim-fadeUp">
                      <div className="text-[10px] text-cyanx font-grotesk uppercase tracking-wider">Exercises found</div>
                      {view.data.exercises.slice(0, 12).map((e) => (
                        <div key={e.id} className="flex items-center gap-2.5 rounded-xl border border-line bg-bg/60 px-3 py-2">
                          <div className="flex-1 min-w-0">
                            <div className="font-grotesk text-[13px] font-semibold">{e.name}</div>
                            <div className="text-[10px] text-mute">{e.primary_muscle}{e.secondary_muscles && e.secondary_muscles !== '—' ? ` · ${e.secondary_muscles}` : ''} · {e.equipment}</div>
                          </div>
                          <span className="chip border-line !px-1.5 !py-0 text-[9px]">{e.difficulty}</span>
                          {e.animation_key && <span title="Has an exercise animation" style={{ color: 'var(--faint)' }}><Icon name="film" size={12} /></span>}
                        </div>
                      ))}
                      {!view.data.exercises.length && <div className="text-xs text-mute py-2">No exercises match — try fewer filters.</div>}
                    </div>
                  )}

                  {view?.kind === 'error' && (
                    <div className="rounded-2xl border border-bad/30 bg-bad/5 p-4 text-[12px] text-ink/80 anim-fadeUp">
                      {view.data.message}
                      <div className="text-[10px] text-faint mt-1.5">Tips: foods like “220g paneer” · workouts like “Bench press 60x8, 65x6” · plans like “4 day hypertrophy, no barbell squats”.</div>
                    </div>
                  )}
                </>
              ) : tab === 'meal' ? (
                /* meal-photo tab — ESTIMATED only */
                <div className="space-y-3">
                  <div className="rounded-2xl border border-dashed border-line p-6 text-center">
                    <div className="mb-2 grid place-items-center" style={{ color: 'var(--faint)' }}><Icon name="plate" size={28} /></div>
                    <div className="text-xs text-mute mb-3">Upload a photo of a meal. Photos only give ESTIMATED calories in a range — never exact values.
                      {!mealBusy && !meal && <span className="block mt-1 text-faint">(Requires an AI vision provider — without one, you can still log it manually.)</span>}
                    </div>
                    <input ref={mealRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden"
                      onChange={(e) => estimateMeal(e.target.files?.[0])} />
                    <button className="btn-primary" onClick={() => mealRef.current?.click()} disabled={mealBusy}>
                      {mealBusy ? 'Estimating…' : 'Upload meal photo'}
                    </button>
                  </div>
                  {meal && (
                    <div className="space-y-2.5 rounded-2xl border border-warn/40 bg-warn/5 p-3.5 anim-fadeUp">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-warn font-grotesk uppercase tracking-wider">Estimated meal · {meal.confidence || 'LOW'} confidence</div>
                        <span className="chip border-warn/40 text-warn text-[8px]">ESTIMATED</span>
                      </div>
                      {meal.note && <div className="text-[11px] text-mute">{meal.note}</div>}
                      {meal.items?.length > 0 && (
                        <div className="space-y-1">
                          {meal.items.map((it, i) => (
                            <div key={i} className="flex justify-between rounded-lg border border-line bg-bg/60 px-3 py-1.5 text-[11px]">
                              <span className="text-mute">{it.food}</span>
                              <span className="font-grotesk font-semibold">{Array.isArray(it.portion_g) ? `${it.portion_g[0]}–${it.portion_g[1]}g` : (it.portion_g ?? '?')}g</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {meal.range?.calories?.[0] != null && (
                        <div className="rounded-xl bg-bg/60 border border-line px-3 py-2 text-center">
                          <span className="font-grotesk font-bold text-base">~{meal.range.calories[0]}–{meal.range.calories[1]} kcal</span>
                          <div className="text-[9px] text-mute uppercase tracking-wide">estimated range</div>
                        </div>
                      )}
                      <div className="text-[9px] text-faint">Photo-based nutrition is always a range — log your actual foods for precise tracking.</div>
                    </div>
                  )}
                </div>
              ) : (
                /* label scan tab */
                <div className="space-y-3">
                  <div className="rounded-2xl border border-dashed border-line p-6 text-center">
                    <div className="mb-2 grid place-items-center" style={{ color: 'var(--faint)' }}><Icon name="camera" size={28} /></div>
                    <div className="text-xs text-mute mb-3">Upload a photo of a packaged-food nutrition label. You review and confirm every value — nothing is trusted blindly.</div>
                    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                      onChange={(e) => scanLabel(e.target.files?.[0])} />
                    <button className="btn-primary" onClick={() => fileRef.current?.click()} disabled={scanning}>
                      {scanning ? 'Reading label…' : 'Upload photo'}
                    </button>
                  </div>
                  {scan && (
                    <div className="space-y-2.5 rounded-2xl border border-gold/30 bg-gold/5 p-3.5 anim-fadeUp">
                      <div className="flex items-center justify-between">
                        <div className="text-[10px] text-gold font-grotesk uppercase tracking-wider">We read this from your label</div>
                        <span className="chip border-gold/40 text-gold text-[8px]">{scan.provenance}</span>
                      </div>
                      <img src={scan.previewUrl} alt="Nutrition label" className="w-full max-h-40 object-contain rounded-xl border border-line" />
                      <div className="text-[10px] text-faint">{scan.note}</div>
                      <div className="grid grid-cols-2 gap-2">
                        <input className="input col-span-2" placeholder="Product name *" value={scan.fields.name} onChange={(e) => setF('name', e.target.value)} />
                        <input className="input" placeholder="Brand" value={scan.fields.brand} onChange={(e) => setF('brand', e.target.value)} />
                        <div className="flex gap-1.5">
                          <input className="input flex-1" placeholder="Serving size" value={scan.fields.serving_size} onChange={(e) => setF('serving_size', e.target.value)} />
                          <input className="input w-14" placeholder="unit" value={scan.fields.unit} onChange={(e) => setF('unit', e.target.value)} />
                        </div>
                        <input className="input" type="number" placeholder="Calories" value={scan.fields.calories} onChange={(e) => setF('calories', e.target.value)} />
                        <input className="input" type="number" placeholder="Protein (g)" value={scan.fields.protein} onChange={(e) => setF('protein', e.target.value)} />
                        <input className="input" type="number" placeholder="Carbs (g)" value={scan.fields.carbs} onChange={(e) => setF('carbs', e.target.value)} />
                        <input className="input" type="number" placeholder="Fat (g)" value={scan.fields.fat} onChange={(e) => setF('fat', e.target.value)} />
                        <input className="input" type="number" placeholder="Fiber (g)" value={scan.fields.fiber} onChange={(e) => setF('fiber', e.target.value)} />
                        <input className="input" type="number" placeholder="Sugar (g)" value={scan.fields.sugar} onChange={(e) => setF('sugar', e.target.value)} />
                        <input className="input" type="number" placeholder="Sodium (mg)" value={scan.fields.sodium} onChange={(e) => setF('sodium', e.target.value)} />
                      </div>
                      <button className="btn-primary w-full !py-2.5 !text-xs" onClick={saveLabel}>SAVE TO MY FOODS</button>
                      <div className="text-[9px] text-faint">Stored with source LABEL_SCANNED · quantity logging scales by your serving size (e.g. “I ate 75g”).</div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {toast && <div className="fixed bottom-24 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full bg-panel border border-gold/40 font-grotesk text-xs shadow-card">{toast}</div>}
    </>
  );
}
