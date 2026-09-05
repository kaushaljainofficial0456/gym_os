import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useAuth } from '../../auth.jsx';
import { useFetch, GOAL_LABEL, fmt1, fmtK, cls } from '../../utils.js';
import { Card, Kicker, Ring, Bar, Spinner, ErrorState, Modal, StatusChip, MacroPill, Seg, CheckIcon, XIcon, PageSkeleton } from '../../components/UI.jsx';
import { WeightChart, AdherenceBreakdown } from '../../components/charts.jsx';
import ExerciseAnim from '../../components/exerciseSVG.jsx';

// Map trainer client-detail response to the shape the existing components expect.
// Owner/admin uses the existing /clients/:id/overview endpoint (returns all org data).
function mapTrainerResponse(tr) {
  return {
    client: {
      id: tr.client.id,
      name: tr.client.name,
      email: tr.client.email,
      avatar: tr.client.avatar,
      goal: tr.client.goal,
      startWeight: tr.client.startWeight,
      currentWeight: tr.client.currentWeight,
      targetWeight: tr.client.targetWeight,
      heightCm: tr.client.height,
      age: tr.client.age,
      sex: tr.client.sex,
      goalDate: tr.client.goalDate,
      status: tr.client.status,
      bmi: tr.client.height && tr.client.currentWeight
        ? Math.round((tr.client.currentWeight / ((tr.client.height / 100) ** 2)) * 10) / 10
        : null,
      lastCheckin: null,
      trainerId: null
    },
    profile: null,
    adherence: {
      score: tr.summary.adherence,
      components: { workout: null, nutrition: tr.summary.nutritionAdherence, protein: null, water: null, sleep: null, checkin: null },
      weights: {}
    },
    rules: (tr.alerts || []).map(a => ({ type: a.type, severity: a.severity, title: a.title, detail: '' })),
    weights: (tr.weight?.history || []).map(w => ({ date: w.date, weight: w.weight })),
    measurements: [],
    photos: [],
    workoutHistory: (tr.workouts?.recent || []).map(w => ({
      id: w.date + w.name,
      name: w.name,
      scheduled_date: w.date,
      status: w.status
    }))
  };
}

export default function ClientProfile() {
  const { id } = useParams();
  const { user } = useAuth();
  const isTrainerOnly = user?.role === 'TRAINER';

  const { data: rawData, loading, error, reload } = useFetch(
    () => isTrainerOnly ? api(`/trainer/clients/${id}/dashboard`) : api(`/clients/${id}/overview`),
    [id, isTrainerOnly]
  );
  const [tab, setTab] = useState('overview');

  if (loading) return <PageSkeleton variant="detail" label="Loading client profile" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  // Normalize: owner gets the raw overview shape, trainer gets the mapped shape
  const data = isTrainerOnly ? mapTrainerResponse(rawData) : rawData;
  const { client, profile, adherence, rules, weights, measurements, photos, workoutHistory } = data;

  const startW = client.startWeight, curW = client.currentWeight, tgtW = client.targetWeight;
  const delta = startW && curW ? Math.round((curW - startW) * 10) / 10 : null;
  const range = startW && tgtW ? Math.max(1, startW - tgtW) : 1;
  const progress = startW && curW && tgtW ? Math.min(100, Math.max(0, ((startW - curW) / range) * 100)) : 0;

  return (
    <div className="space-y-5">
      {/* hero */}
      <div className="card !p-6 overflow-hidden relative anim-fadeUp">
        <div className="absolute -top-24 -right-16 w-72 h-72 rounded-full bg-ember/8 blur-[90px] pointer-events-none" />
        <div className="flex flex-wrap items-center gap-4 relative">
          <div className="w-16 h-16 rounded-2xl grid place-items-center bg-gradient-to-br from-ember/40 to-gold/25 border border-line font-grotesk font-bold text-2xl shadow-glow">
            {client.name[0]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              {/* font-brand, not font-grotesk -- see Business.jsx's hero
                  for why: trainer scope repoints font-grotesk to DM Sans
                  for supporting text, so a name-as-headline stays on the
                  bolder face on purpose. */}
              <h1 className="font-brand font-black text-3xl tracking-tight" style={{ color: 'var(--ink)' }}>{client.name}</h1>
              <StatusChip status={client.status} />
            </div>
            <div className="text-xs text-mute mt-1 font-grotesk">
              {/* Was an unconditional template: with no target weight and no
                  goal date it rendered the literal "· Goal  kg by " — three
                  orphaned words and a stray "kg" that read as a broken
                  screen rather than as absent data. Each clause is now
                  present only when it has a value to state. */}
              {[
                client.age && `${client.age} yrs`,
                GOAL_LABEL[client.goal],
                client.bmi != null && `BMI ${client.bmi}`,
                client.targetWeight != null && `Goal ${client.targetWeight} kg`,
                client.goalDate && `by ${client.goalDate.slice(0, 10)}`,
              ].filter(Boolean).join(' · ')}
            </div>
            {delta !== null && (
              <div className="mt-1.5 text-xs font-grotesk">
                {/* Was the '▲'/'▼' geometric-shape characters. Those come
                    from whatever font resolves U+25B2, render at a different
                    weight than the label beside them, and sit off the text
                    baseline. */}
                <span className={`inline-flex items-center gap-1 ${delta <= 0 ? 'text-good' : 'text-bad'}`}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d={delta > 0 ? 'M12 4l9 16H3z' : 'M12 20L3 4h18z'} />
                  </svg>
                  {Math.abs(delta)} kg {delta > 0 ? 'gained' : 'lost'} since start
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-7 text-center">
            {[['Start', startW], ['Current', curW], ['Target', tgtW]].map(([l, v], i) => (
              <div key={l} className="anim-fadeUp" style={{ animationDelay: `${100 + i * 80}ms` }}>
                <div className="font-grotesk font-bold text-2xl tracking-tight">{v ?? '—'}</div>
                <div className="text-[9px] uppercase tracking-widest text-mute font-grotesk">{l} kg</div>
              </div>
            ))}
          </div>
        </div>

        {/* Weight progression bar.
            Rendered only when there IS a journey to show. Without a start
            and a target this drew an empty track under the labels
            "Start  kg" / "0% of journey" / "Target  kg" — a progress bar
            for a goal that does not exist, which is worse than no bar.
            The fill also carried `boxShadow: rgb(var(--accent-rgb) / .5)` — a TEAL
            glow, from the same dead palette as the Razorpay theme colour
            and the avatar gradient, sitting behind a terracotta gradient. */}
        {startW != null && tgtW != null && (
          <div className="mt-6 relative">
            <div className="meter" style={{ height: 8 }}>
              <span className="meter-fill" style={{ width: `${progress}%`, background: 'var(--accent-grad)' }} />
            </div>
            <div className="flex justify-between mt-2 text-[10px] text-faint font-grotesk tabular-nums">
              <span>Start {startW} kg</span>
              <span className="font-semibold" style={{ color: 'var(--accent)' }}>{Math.round(progress)}% of journey</span>
              <span>Target {tgtW} kg</span>
            </div>
          </div>
        )}
      </div>

      <Seg options={[
        { value: 'overview', label: 'Overview' },
        { value: 'training', label: 'Training' },
        { value: 'workouts', label: 'Workouts' },
        { value: 'nutrition', label: 'Nutrition' },
        { value: 'photos', label: 'Photos' },
        { value: 'ai', label: 'AI Coach' },
        { value: 'messages', label: 'Messages' }
      ]} value={tab} onChange={setTab} />

      {tab === 'overview' && <OverviewTab client={client} profile={profile} adherence={adherence} rules={rules} weights={weights} measurements={measurements} onChanged={reload} />}
      {tab === 'training' && <TrainingTab clientId={id} />}
      {tab === 'workouts' && <WorkoutsTab clientId={id} history={workoutHistory} onChanged={reload} />}
      {tab === 'nutrition' && <NutritionTab clientId={id} profile={profile} />}
      {tab === 'photos' && <PhotosTab clientId={id} photos={photos} onChanged={reload} />}
      {tab === 'ai' && <AITab clientId={id} />}
      {tab === 'messages' && <MessagesTab clientId={id} />}
    </div>
  );
}

/* ---------------- Training (program + volume + equipment) ---------------- */
function TrainingTab({ clientId }) {
  const prog = useFetch(() => api(`/clients/${clientId}/program`));
  const volume = useFetch(() => api(`/clients/${clientId}/volume?days=7`));
  const equip = useFetch(() => api(`/clients/${clientId}/equipment`));
  const [equipEdit, setEquipEdit] = useState(null);
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (prog.loading || volume.loading || equip.loading) return <PageSkeleton variant="detail" label="Loading client profile" />;
  if (volume.error) return <ErrorState error={volume.error} onRetry={volume.reload} />;

  const v = volume.data?.volume;
  const days = prog.data?.program?.days || [];
  const equipData = equip.data;

  const saveEquip = async () => {
    try {
      await api(`/clients/${clientId}/equipment`, { method: 'PATCH', body: JSON.stringify({ equipment: equipEdit }) });
      setToast('Equipment profile updated');
      setEquipEdit(null);
      // silent: true -- this page gates its whole render on
      // `prog.loading || volume.loading || equip.loading` (above); a bare
      // reload() would unmount everything for the duration of the
      // refetch, same class of bug already fixed for Nutrition.jsx.
      equip.reload({ silent: true });
    } catch (e) { setToast(e.message); }
  };

  const tone = (status) => status === 'UNDERTRAINED' ? 'text-warn' : status === 'HIGH_VOLUME' ? 'text-bad' : 'text-good';

  return (
    <div className="space-y-4">
      {/* program week */}
      <Card>
        <Kicker>Training program</Kicker>
        {prog.data?.program ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <span className="font-grotesk font-semibold">{prog.data.program.name}</span>
              <span className="chip border-gold/30 text-gold">{prog.data.program.split.replace(/_/g, ' ')}</span>
              <span className="chip border-line text-mute">{prog.data.program.days_per_week} days / week</span>
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
                const day = days.find((d) => d.day_of_week === dow);
                return (
                  <div key={dow} className={`rounded-lg border px-1.5 py-2 text-center ${day ? 'border-gold/40 bg-gold/10' : 'border-line bg-tint/[.02]'}`}>
                    <div className="text-[8px] font-grotesk font-bold text-mute">{['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][dow]}</div>
                    <div className={`text-[9px] font-grotesk font-semibold mt-0.5 leading-tight ${day ? 'text-gold' : 'text-faint'}`}>{day ? day.name.split(' ')[0] : 'rest'}</div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-sm text-mute">No active program — assign one in the Workout builder.</div>
        )}
      </Card>

      {/* weekly muscle balance */}
      <Card>
        <Kicker>Weekly muscle balance · last {v?.days || 7} days</Kicker>
        <p className="text-[11px] text-mute leading-relaxed mb-3">{v?.note}</p>
        {v?.muscles?.length ? (
          <div className="space-y-2.5">
            {v.muscles.slice(0, 12).map((m) => (
              <div key={m.id}>
                <div className="flex items-center justify-between mb-1">
                  <span className="font-grotesk text-xs font-semibold">{m.name}</span>
                  <span className={`text-[10px] font-grotesk ${tone(m.status)}`}>
                    {m.sets} sets · target {m.min}–{m.max} · {m.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-tint/8 overflow-hidden">
                  <div className="h-full rounded-full bg-gradient-to-r from-ember to-gold transition-all duration-700"
                    style={{ width: `${Math.min(100, (m.sets / (m.max || 16)) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-mute">No workout volume in the last {v?.days || 7} days yet.</div>
        )}
      </Card>

      {/* movement patterns */}
      {v?.movements?.length > 0 && (
        <Card>
          <Kicker>Movement patterns</Kicker>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {v.movements.map((mv) => (
              <span key={mv.movement} className="chip border-line">{mv.movement.replace(/_/g, ' ')} · {mv.sets} sets</span>
            ))}
          </div>
        </Card>
      )}

      {/* equipment profile */}
      <Card>
        <Kicker>Equipment profile</Kicker>
        {equipEdit === null ? (
          <>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {equipData?.items?.map((it) => {
                const has = equipData?.full_gym || equipData?.available?.includes(it.id);
                return (
                  <span key={it.id} className={`chip border ${has ? 'text-good border-good/40 bg-good/10' : 'text-faint'}`}>
                    {has ? <CheckIcon /> : <XIcon />} {it.label}
                  </span>
                );
              })}
            </div>
            {!!equipData?.issues?.length && (
              <div className="mt-3 rounded-xl border border-warn/30 bg-warn/5 px-3 py-2.5 text-[11px]">
                <div className="text-warn font-grotesk font-semibold mb-1 flex items-center gap-1.5"><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg> Program needs equipment this client doesn't have</div>
                {equipData.issues.map((i) => (
                  <div key={i.name} className="text-mute">{i.name} — needs {i.missing.join(', ')}</div>
                ))}
              </div>
            )}
            <button className="btn btn-sm mt-3" onClick={() => setEquipEdit(equipData?.full_gym ? ['full_gym'] : (equipData?.available || []))}>Edit equipment</button>
          </>
        ) : (
          <div className="mt-2">
            <div className="flex flex-wrap gap-1.5">
              {equipData?.items?.map((it) => {
                const checked = equipEdit.includes(it.id) || equipEdit.includes('full_gym');
                return (
                  <label key={it.id} className={`chip border cursor-pointer transition-colors ${checked ? 'border-good/50 bg-good/10 text-good' : 'border-line text-mute'}`}>
                    <input type="checkbox" className="hidden" checked={checked}
                      onChange={(e) => setEquipEdit((arr) => e.target.checked ? [...arr.filter((x) => x !== 'full_gym'), it.id] : arr.filter((x) => x !== it.id))} />
                    {checked ? '✓ ' : ''}{it.label}
                  </label>
                );
              })}
            </div>
            <div className="flex gap-2 mt-3">
              <button className="btn-primary btn-sm" onClick={saveEquip}>Save</button>
              <button className="btn btn-sm" onClick={() => setEquipEdit(null)}>Cancel</button>
            </div>
          </div>
        )}
      </Card>

      {toast && <div className="toast anim-toast">{toast}</div>}
    </div>
  );
}

/* ---------------- Overview ---------------- */
function OverviewTab({ client, profile, adherence, rules, weights, measurements, onChanged }) {
  const [w, setW] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => {
    if (!toast) return undefined;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);
  const logWeight = async () => {
    if (!w) return;
    setBusy(true);
    try {
      await api(`/clients/${client.id}/weights`, { method: 'POST', body: JSON.stringify({ weight: Number(w) }) });
      setW('');
      // A full location.reload() here used to throw away the whole app
      // state for one new data point. onChanged() re-fetches just the
      // client overview -- the same pattern WorkoutsTab/PhotosTab already
      // use -- so the weight chart updates without the page flashing.
      onChanged?.();
    } catch (e) { setToast(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      {toast && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-full font-grotesk text-xs shadow-card border"
          style={{ background: 'var(--panel)', color: 'var(--ink)', borderColor: 'var(--accent-soft)' }}>
          {toast}
        </div>
      )}
      <Card className="lg:col-span-1">
        <Kicker>Adherence score</Kicker>
        <div className="flex justify-center py-2">
          <Ring value={adherence.score} max={100} label={`${Math.round(adherence.score)}%`} sub="7-day score" />
        </div>
        <AdherenceBreakdown components={adherence.components} />
        <div className="mt-4 flex gap-2">
          <input className="input flex-1" type="number" placeholder="Log weight kg" value={w} onChange={(e) => setW(e.target.value)} />
          <button className="btn-primary" onClick={logWeight} disabled={busy || !w}>Log</button>
        </div>
      </Card>

      <Card className="lg:col-span-2">
        <Kicker>Weight trend</Kicker>
        {/* WeightChart returns null on an empty series, so this card
            rendered as a heading floating over blank space — the most
            common "is it broken or just empty?" failure in the product. */}
        {weights.length >= 2 ? <WeightChart data={weights} /> : (
          <div className="empty-state" style={{ padding: '20px 16px' }}>
            <p className="empty-state-body">
              {weights.length === 1
                ? 'One weight logged so far. A second entry draws the trend.'
                : 'No weight entries yet.'}
            </p>
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-2 mt-4">
          {measurements.slice(0, 3).map((m) => (
            <div key={m.id} className="rounded-xl border border-line bg-tint/[.02] p-3">
              <div className="text-[9px] uppercase tracking-widest text-mute font-grotesk">{m.taken_at.slice(0, 10)}</div>
              <div className="font-grotesk font-bold mt-1">{m.weight ?? '—'} kg</div>
              {m.waist && <div className="text-[10px] text-mute">Waist {m.waist} cm</div>}
            </div>
          ))}
        </div>
      </Card>

      <Card className="lg:col-span-3">
        <Kicker tone="cyan">Why this client needs attention</Kicker>
        {rules.length ? (
          <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-2">
            {rules.map((r) => (
              <div key={r.type} className={cls('rounded-xl border p-3',
                r.severity === 'high' ? 'border-bad/40 bg-bad/8' : r.severity === 'medium' ? 'border-warn/40 bg-warn/8' : 'border-line bg-tint/[.02]')}>
                <div className="flex items-center gap-2">
                  <span className={cls('w-1.5 h-1.5 rounded-full', r.severity === 'high' ? 'bg-bad' : r.severity === 'medium' ? 'bg-warn' : 'bg-mute')} />
                  <span className="font-grotesk text-xs font-semibold">{r.title}</span>
                </div>
                <div className="text-[11px] text-mute mt-1">{r.detail}</div>
              </div>
            ))}
          </div>
        ) : (
     <div className="text-sm text-mute">No active concerns — this client is tracking well. </div>
        )}
        {profile?.food_exclusions && (
          <div className="mt-3 text-[11px] text-mute">Food exclusions: <b className="text-ink">{profile.food_exclusions}</b></div>
        )}
      </Card>
    </div>
  );
}

/* ---------------- Workouts ---------------- */
function WorkoutsTab({ clientId, history, onChanged }) {
  const tmpl = useFetch(() => api('/workouts/templates'));
  const [assignOpen, setAssignOpen] = useState(false);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <Kicker>Workout history</Kicker>
        <button className="btn-primary" onClick={() => setAssignOpen(true)}>+ Assign workout</button>
      </div>
      <div className="space-y-3">
        {history.map((w) => (
          <div key={w.id} className="rounded-2xl border border-line bg-tint/[.02] p-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="font-grotesk font-semibold">{w.name}</div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-mute font-grotesk">{w.scheduled_date}</span>
                <span className={cls('chip', w.status === 'completed' ? '!text-good !border-good/40' : w.status === 'missed' ? '!text-bad !border-bad/40' : '!text-gold !border-gold/40')}>
                  {w.status}
                </span>
              </div>
            </div>
          </div>
        ))}
        {!history.length && <div className="text-center py-8 text-mute text-sm">No workouts assigned yet.</div>}
      </div>
      {assignOpen && (
        <AssignWorkout clientId={clientId} templates={tmpl.data?.templates || []} onClose={() => setAssignOpen(false)}
          onDone={() => { setAssignOpen(false); onChanged(); }} />
      )}
    </Card>
  );
}

function AssignWorkout({ clientId, templates, onClose, onDone }) {
  const [templateId, setTemplateId] = useState(templates[0]?.id || '');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const t = templates.find((x) => x.id === templateId);

  const submit = async () => {
    if (!t) return;
    setBusy(true);
    setErr('');
    try {
      await api(`/workouts/clients/${clientId}/assign`, {
        method: 'POST',
        body: JSON.stringify({
          name: t.name, day_label: t.name, scheduled_date: date,
          exercises: t.exercises.map((e) => ({
            exercise_id: e.exercise_id, name: e.name, sets: e.sets, reps: e.reps,
            weight: e.weight, rest_sec: e.rest_sec, tempo: e.tempo, notes: e.notes
          }))
        })
      });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="Assign workout">
      <div className="space-y-3">
        {/* A native alert() blocks the whole tab and looks like a browser
            error, not a product one -- shown inline instead, same as every
            other form error in this app. */}
        {err && (
          <div className="text-xs text-bad rounded-xl px-3 py-2 border" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>
            {err}
          </div>
        )}
        <select className="input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
          {templates.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.exercises.length} exercises</option>)}
        </select>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        {t && (
          <div className="rounded-xl border border-line bg-tint/[.02] p-3 text-xs text-mute font-grotesk space-y-1">
            {t.exercises.map((e, i) => (
              <div key={i}>{e.name} — {e.sets}×{e.reps}×{e.weight}</div>
            ))}
          </div>
        )}
        <button className="btn-primary w-full" onClick={submit} disabled={busy || !t}>{busy ? 'Assigning…' : 'Assign workout'}</button>
      </div>
    </Modal>
  );
}

/* ---------------- Nutrition ---------------- */
function NutritionTab({ clientId, profile }) {
  const { data, loading, reload } = useFetch(() => api(`/nutrition/clients/${clientId}/meals`));
  const plans = useFetch(() => api('/nutrition/plans'));
  const [planOpen, setPlanOpen] = useState(false);

  const toggle = async (meal) => {
    await api(`/nutrition/clients/${clientId}/meals/toggle`, {
      method: 'POST', body: JSON.stringify({ meal_id: meal.id, eaten: !meal.eaten })
    });
    // silent: true -- this card renders `loading ? <Spinner/> : (...)`
    // inline (below); a bare reload() would flash the whole card to a
    // spinner and back for every toggle, same class of bug already
    // fixed for Nutrition.jsx.
    reload({ silent: true });
  };

  return (
    <div className="grid lg:grid-cols-3 gap-5">
      <Card className="lg:col-span-2">
        <div className="flex items-center justify-between mb-4">
          <Kicker tone="gold">Today's fuel plan</Kicker>
          <button className="btn" onClick={() => setPlanOpen(true)}>Assign plan</button>
        </div>
        {loading ? <Spinner /> : (
          <div className="space-y-2">
            {data?.meals.map((m) => (
              <button key={m.id} onClick={() => toggle(m)}
                className={cls('w-full flex items-center gap-3 p-3 rounded-2xl border transition-colors text-left',
                  m.eaten ? 'border-gold/30 bg-gold/5' : 'border-line bg-tint/[.02] hover:bg-tint/[.05]')}>
                <span className={cls('w-5 h-5 rounded-full border-2 grid place-items-center text-[10px] shrink-0',
                  m.eaten ? 'border-gold bg-gold text-bg' : 'border-tint/20')}>{m.eaten ? '✓' : ''}</span>
                <span className="flex-1 min-w-0">
                  <span className="block font-grotesk text-sm font-semibold">{m.name}</span>
                  <span className="block text-[11px] text-mute">{m.slot} · {m.time}</span>
                </span>
                <span className="text-right">
                  <span className="block font-grotesk font-semibold text-gold">{m.calories} kcal</span>
                  <MacroPill p={m.protein} c={m.carbs} f={m.fat} />
                </span>
              </button>
            ))}
            {data?.customLogs?.map((m) => (
              <div key={m.id} className="flex items-center gap-3 p-3 rounded-2xl border border-cyanx/30 bg-cyanx/5">
                <span className="w-5 h-5 rounded-full border-2 border-cyanx grid place-items-center text-[10px] text-bg bg-cyanx"><CheckIcon /></span>
                <span className="flex-1 font-grotesk text-sm">{m.name} <span className="text-[10px] text-mute">· AI estimate</span></span>
                <span className="font-grotesk text-xs">{m.calories} kcal</span>
              </div>
            ))}
            {!data?.meals.length && <div className="text-center py-8 text-mute text-sm">No plan assigned yet.</div>}
          </div>
        )}
      </Card>
      <Card>
        <Kicker>Plan targets</Kicker>
        {data?.plan ? (
          <div className="space-y-4">
            <Bar label="Calories" value={0} max={data.plan.calories} right={`${fmtK(data.plan.calories)} kcal`} />
            <Bar label="Protein" value={0} max={data.plan.protein} right={`${data.plan.protein} g`} />
            <Bar label="Carbs" value={0} max={data.plan.carbs} right={`${data.plan.carbs} g`} />
            <Bar label="Fat" value={0} max={data.plan.fat} right={`${data.plan.fat} g`} />
          </div>
        ) : <div className="text-sm text-mute">Assign a nutrition plan to see targets.</div>}
      </Card>
      {planOpen && (
        <Modal open onClose={() => setPlanOpen(false)} title="Assign nutrition plan" wide>
          <div className="space-y-2">
            {plans.data?.plans.map((p) => (
              <button key={p.id} className="w-full flex items-center justify-between p-3 rounded-2xl border border-line bg-tint/[.02] hover:bg-tint/[.05]"
                onClick={async () => {
                  await api(`/nutrition/clients/${clientId}/plan/assign`, { method: 'POST', body: JSON.stringify({ plan_id: p.id }) });
                  setPlanOpen(false); plans.reload({ silent: true }); reload({ silent: true });
                }}>
                <span className="font-grotesk font-semibold">{p.name}</span>
                <span className="text-xs text-mute font-grotesk">{p.calories} kcal · {p.meals.length} meals</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ---------------- Photos ---------------- */
function PhotosTab({ clientId, photos, onChanged }) {
  const [view, setView] = useState('front');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef();

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        await api(`/clients/${clientId}/photos`, {
          method: 'POST',
          body: JSON.stringify({ view, data_url: reader.result, is_before: false })
        });
        onChanged(); setUploading(false);
      };
      reader.readAsDataURL(file);
    } catch { setUploading(false); }
  };

  const group = (v) => photos.filter((p) => p.view === v);

  return (
    <div className="grid md:grid-cols-3 gap-5">
      {['front', 'side', 'back'].map((v) => {
        const shots = group(v);
        const before = shots[0];
        const after = shots[shots.length - 1];
        return (
          <Card key={v}>
            <Kicker tone="cyan">{v.toUpperCase()} view</Kicker>
            {after?.data_url ? (
              <BeforeAfter before={before?.data_url} after={after.data_url} />
            ) : (
              <div className="rounded-2xl border border-dashed border-line h-64 grid place-items-center text-mute text-sm">
                No {v} photo yet
              </div>
            )}
            <button className="btn w-full mt-3" onClick={() => { setView(v); fileRef.current?.click(); }} disabled={uploading}>
              {uploading ? 'Uploading…' : `+ Upload ${v} photo`}
            </button>
          </Card>
        );
      })}
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={upload} />
    </div>
  );
}

function BeforeAfter({ before, after }) {
  const [pos, setPos] = useState(50);
  if (!before || !after) return null;
  return (
    <div className="relative rounded-2xl overflow-hidden h-64 select-none border border-line">
      <img src={after} alt="After" className="absolute inset-0 w-full h-full object-cover" />
      <img src={before} alt="Before" className="absolute inset-0 w-full h-full object-cover"
        style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }} />
      <input type="range" min="0" max="100" value={pos} onChange={(e) => setPos(Number(e.target.value))}
        className="absolute inset-0 w-full h-full opacity-0 cursor-ew-resize" aria-label="Compare photos" />
      <div className="absolute inset-y-0" style={{ left: `${pos}%` }}>
        <div className="h-full w-0.5 bg-white/80" />
        <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-8 h-8 rounded-full bg-white/90 text-bg grid place-items-center text-xs font-bold" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m8 8-4 4 4 4M16 8l4 4-4 4"/></svg></div>
      </div>
      <span className="absolute top-2 left-2 chip !text-[9px]">BEFORE</span>
      <span className="absolute top-2 right-2 chip !text-[9px]">AFTER</span>
    </div>
  );
}

/* ---------------- AI Coach ---------------- */
function AITab({ clientId }) {
  const { data, loading, reload } = useFetch(() => api(`/insights/clients/${clientId}`));
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);
  const [err, setErr] = useState('');

  const analyze = async () => {
    setBusy(true);
    setErr('');
    // silent: true -- this card renders `loading ? <Spinner/> : (...)`
    // inline (below); a bare reload() would flash the whole card to a
    // spinner and back, same class of bug already fixed for Nutrition.jsx.
    try { await api(`/insights/clients/${clientId}/analyze`, { method: 'POST', body: '{}' }); reload({ silent: true }); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const action = async (id, action) => {
    await api(`/insights/${id}/action`, { method: 'POST', body: JSON.stringify({ action }) });
    reload({ silent: true });
  };

  return (
    <div className="space-y-4">
      {err && <div className="text-xs text-bad rounded-xl px-3 py-2 border" style={{ borderColor: 'var(--line)', background: 'var(--panel2)' }}>{err}</div>}
      <div className="card !p-0 overflow-hidden" style={{ padding: 1, background: 'linear-gradient(135deg, rgba(8,127,123,.55), rgb(var(--accent-rgb) / .28) 45%, rgba(155,124,255,.4))', borderRadius: 19 }}>
        <div className="bg-panel rounded-[18px] p-5 relative overflow-hidden">
          <div className="absolute -top-20 -right-16 w-64 h-64 rounded-full bg-violetx/10 blur-[80px] pointer-events-none" />
          <div className="flex items-center justify-between flex-wrap gap-3 relative">
            <div className="flex items-center gap-3">
              <img src="/logo.png" alt="SK Coach" className="w-10 h-10 rounded-xl object-cover shadow-glow" />
              <div>
                <div className="font-grotesk font-bold">SK Coach AI · Client analysis</div>
                <div className="text-xs text-mute mt-0.5 max-w-md">
                  Insights derived only from recorded data — <b className="text-cyanx">measured</b>, <b className="text-gold">calculated</b>, or <b className="text-violetx">estimated</b>.
                </div>
              </div>
            </div>
            <button className="btn-primary" onClick={analyze} disabled={busy}>{busy ? 'Analyzing…' : 'Analyze client'}</button>
          </div>
        </div>
      </div>

      {loading ? <Spinner /> : (
        <div className="space-y-3">
          {(data?.insights || []).map((ins) => (
            <Card key={ins.id} className="anim-fadeUp">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
                <span className="chip !text-gold !border-gold/40">{ins.type.replace(/_/g, ' ')}</span>
                <span className={cls('chip', ins.status === 'accepted' ? '!text-good !border-good/40' : ins.status === 'dismissed' ? '!text-mute' : '!text-warn !border-warn/40')}>
                  {ins.status}
                </span>
              </div>
              <p className="text-sm leading-relaxed">{ins.summary}</p>
              <div className="mt-2 rounded-xl border border-gold/25 bg-gold/5 p-3 text-sm">
                <span className="text-[10px] uppercase tracking-widest text-gold font-grotesk">Recommended action · </span>
                {ins.recommendation}
              </div>
              {editing === ins.id ? (
                <div className="mt-3 space-y-2">
                  <textarea className="input" defaultValue={ins.summary} id={`s${ins.id}`} rows={2} />
                  <textarea className="input" defaultValue={ins.recommendation} id={`r${ins.id}`} rows={2} />
                  <div className="flex gap-2">
                    <button className="btn-primary" onClick={async () => {
                      await api(`/insights/${ins.id}/action`, {
                        method: 'POST',
                        body: JSON.stringify({ action: 'modify', summary: document.getElementById(`s${ins.id}`).value, recommendation: document.getElementById(`r${ins.id}`).value })
                      });
                      setEditing(null); reload({ silent: true });
                    }}>Save changes</button>
                    <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2 mt-3 flex-wrap">
                  <button className="btn btn-sm !border-good/40" onClick={() => action(ins.id, 'accept')}>✓ Accept</button>
                  <button className="btn" onClick={() => setEditing(ins.id)}><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }}><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg> Modify</button>
                  <button className="btn btn-sm !text-mute" onClick={() => action(ins.id, 'dismiss')}>Dismiss</button>
                </div>
              )}
            </Card>
          ))}
          {!data?.insights?.length && <Card><div className="text-center py-8 text-mute text-sm">No insights yet — run an analysis.</div></Card>}
        </div>
      )}
    </div>
  );
}

/* ---------------- Messages ---------------- */
function MessagesTab({ clientId }) {
  const { data, loading, reload } = useFetch(() => api(`/messages?client_id=${clientId}`));
  const [body, setBody] = useState('');
  const endRef = useRef();
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [data]);

  const send = async (e) => {
    e.preventDefault();
    if (!body.trim()) return;
    await api('/messages', { method: 'POST', body: JSON.stringify({ client_id: clientId, type: 'message', body }) });
    // silent: true -- the thread renders `loading ? <Spinner/> : (...)`
    // inline (below); a bare reload() would flash the whole conversation
    // to a spinner and back on every message sent, same class of bug
    // already fixed for Nutrition.jsx.
    setBody(''); reload({ silent: true });
  };

  return (
    <Card>
      <Kicker>Conversation</Kicker>
      <div className="h-96 overflow-y-auto space-y-2 pr-1 mb-3">
        {loading ? <Spinner /> : (data?.messages || []).map((m) => (
          <div key={m.id} className={cls('max-w-[80%] rounded-2xl p-3 text-sm',
            m.from_name === 'client' ? 'bg-tint/5 border border-line' : 'bg-gradient-to-r from-ember/20 to-gold/10 border border-gold/20')}>
            <div className="text-[10px] text-mute mb-1 font-grotesk">{m.from_name} · {m.created_at.slice(0, 16).replace('T', ' ')}</div>
            {m.body}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} className="flex gap-2">
        <input className="input flex-1" placeholder="Message the client…" value={body} onChange={(e) => setBody(e.target.value)} />
        <button className="btn-primary">Send</button>
      </form>
    </Card>
  );
}
