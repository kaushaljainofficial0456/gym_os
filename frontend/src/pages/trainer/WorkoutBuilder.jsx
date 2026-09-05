import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { Card, Kicker, ErrorState, Modal, Empty, ChevronRightIcon, XIcon, PageSkeleton } from '../../components/UI.jsx';
import MuscleBody3D from '../../components/anatomy/MuscleBody3D.jsx';

const emptyEx = () => ({ exercise_id: null, name: '', sets: 3, reps: '10', weight: 'BW', rest_sec: 90, tempo: '', notes: '' });

// ---- training program presets (day-of-week: 1=Mon..6=Sat,0=Sun) ----
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DOW_LABEL = { 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT', 0: 'SUN' };

// Logically consistent split presets — daysPerWeek always matches the
// number of enabled training days, and each preset maps to a Mon–Sun grid.
const SPLIT_PRESETS = {
  PPL_3: { label: 'PPL 3', daysPerWeek: 3, days: [
    { dow: 1, name: 'Push Day', focus: 'CHEST, SHOULDERS, TRICEPS' },
    { dow: 3, name: 'Pull Day', focus: 'BACK, BICEPS, REAR DELTS' },
    { dow: 5, name: 'Leg Day', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' }
  ] },
  PPL_4: { label: 'PPL 4', daysPerWeek: 4, days: [
    { dow: 1, name: 'Push Day', focus: 'CHEST, SHOULDERS, TRICEPS' },
    { dow: 2, name: 'Pull Day', focus: 'BACK, BICEPS, REAR DELTS' },
    { dow: 4, name: 'Leg Day', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' },
    { dow: 5, name: 'Upper Body', focus: 'CHEST, BACK, SHOULDERS, ARMS' }
  ] },
  PPL_5: { label: 'PPL 5', daysPerWeek: 5, days: [
    { dow: 1, name: 'Push Day', focus: 'CHEST, SHOULDERS, TRICEPS' },
    { dow: 2, name: 'Pull Day', focus: 'BACK, BICEPS, REAR DELTS' },
    { dow: 3, name: 'Leg Day', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' },
    { dow: 5, name: 'Upper Body', focus: 'CHEST, BACK, SHOULDERS, ARMS' },
    { dow: 6, name: 'Lower Body', focus: 'QUADS, HAMSTRINGS, GLUTES' }
  ] },
  PPL_6: { label: 'PPL 6', daysPerWeek: 6, days: [
    { dow: 1, name: 'Push A', focus: 'CHEST, SHOULDERS, TRICEPS' },
    { dow: 2, name: 'Pull A', focus: 'BACK, BICEPS, REAR DELTS' },
    { dow: 3, name: 'Legs A', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' },
    { dow: 4, name: 'Push B', focus: 'CHEST, SHOULDERS, TRICEPS' },
    { dow: 5, name: 'Pull B', focus: 'BACK, BICEPS, REAR DELTS' },
    { dow: 6, name: 'Legs B', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' }
  ] },
  UPPER_LOWER: { label: 'Upper / Lower 4', daysPerWeek: 4, days: [
    { dow: 1, name: 'Upper A', focus: 'CHEST, BACK, SHOULDERS, ARMS' },
    { dow: 2, name: 'Lower A', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' },
    { dow: 4, name: 'Upper B', focus: 'CHEST, BACK, SHOULDERS, ARMS' },
    { dow: 5, name: 'Lower B', focus: 'QUADS, HAMSTRINGS, GLUTES, CALVES' }
  ] },
  FULL_BODY_2: { label: 'Full Body 2', daysPerWeek: 2, days: [
    { dow: 1, name: 'Full Body A', focus: 'FULL BODY' },
    { dow: 4, name: 'Full Body B', focus: 'FULL BODY' }
  ] },
  FULL_BODY_3: { label: 'Full Body 3', daysPerWeek: 3, days: [
    { dow: 1, name: 'Full Body A', focus: 'FULL BODY' },
    { dow: 3, name: 'Full Body B', focus: 'FULL BODY' },
    { dow: 5, name: 'Full Body C', focus: 'FULL BODY' }
  ] },
  CUSTOM: { label: 'Custom', daysPerWeek: 0, days: [] }
};

// pick a sensible template default for a day name (best-effort by type)
// resolved with the loaded templates list via makeTemplateResolver()

export default function WorkoutBuilder() {
  const tpl = useFetch(() => api('/workouts/templates'));
  const lib = useFetch(() => api('/workouts/exercises'));
  const clients = useFetch(() => api('/clients?sort=name'));

  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null); // draft {id?, name, type, notes, exercises[]}
  const [saving, setSaving] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignClient, setAssignClient] = useState('');
  const [assignDate, setAssignDate] = useState('');
  const [toast, setToast] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', primary_muscle: '', equipment: 'BW', difficulty: 'BEGINNER', instructions: '', cues: '', animation_key: '' });
  const [addSaving, setAddSaving] = useState(false);

  // ---- 3D muscle picker: rotate the body, click a muscle, get matching
  // exercises from the same library the "link from library" dropdown uses.
  const [pickOpen, setPickOpen] = useState(false);
  const [pickGroup, setPickGroup] = useState(null);
  const [pickLabel, setPickLabel] = useState('');

  // ---- training programs ----
  const [progClient, setProgClient] = useState('');
  const [currentProg, setCurrentProg] = useState(null);
  const [progOpen, setProgOpen] = useState(false);
  const [progSaving, setProgSaving] = useState(false);
  const [progForm, setProgForm] = useState(null);

  const loadProgram = async (clientId) => {
    setProgClient(clientId);
    setCurrentProg(null);
    if (!clientId) return;
    try {
      const r = await api(`/clients/${clientId}/program`);
      setCurrentProg(r.program);
    } catch { setCurrentProg(null); }
  };

  const tplFor = (name) => {
    const n = (name || '').toLowerCase();
    const type = n.includes('push') ? 'push' : n.includes('pull') ? 'pull' : n.includes('leg') ? 'legs' : n.includes('upper') || n.includes('full') ? 'full' : null;
    const match = type ? templates.find((t) => (t.type || '').toLowerCase().includes(type)) : null;
    return match?.id || '';
  };

  const openProgramModal = (existing) => {
    const split = existing?.split || 'PPL_5';
    const preset = SPLIT_PRESETS[split] || SPLIT_PRESETS.CUSTOM;
    const days = DOW_ORDER.map((dow) => {
      const ex = existing?.days?.find((d) => d.day_of_week === dow) || preset.days.find((d) => d.dow === dow);
      return {
        dow, enabled: !!ex,
        name: ex?.name || '',
        focus: ex?.focus_muscles || ex?.focus || '',
        template_id: ex?.template_id || tplFor(ex?.name || '')
      };
    });
    setProgForm({ name: existing?.name || 'Push / Pull / Legs', split, days_per_week: existing?.days_per_week || preset.daysPerWeek, days });
    setProgOpen(true);
  };

  const saveProgram = async () => {
    if (!progClient) return setToast('Pick a client first');
    setProgSaving(true);
    try {
      await api(`/clients/${progClient}/program`, {
        method: 'PUT',
        body: JSON.stringify({
          name: progForm.name || 'Training program',
          split: progForm.split,
          days_per_week: progForm.days.filter((d) => d.enabled).length,
          days: progForm.days.filter((d) => d.enabled).map((d) => ({
            day_of_week: d.dow, name: d.name || DOW_LABEL[d.dow] + ' session',
            focus_muscles: d.focus || null, template_id: d.template_id || null
          }))
        })
      });
      setToast('Program assigned — client workouts update automatically');
      setProgOpen(false);
      loadProgram(progClient);
    } catch (e) { setToast(e.message); }
    setProgSaving(false);
  };

  const templates = tpl.data?.templates || [];
  const exercises = lib.data?.exercises || [];
  const clientList = clients.data?.clients || [];

  const selected = useMemo(
    () => templates.find((t) => t.id === selectedId) || null,
    [templates, selectedId]
  );

  const pickMatches = useMemo(() => {
    if (!pickGroup) return [];
    return exercises.filter((x) => x.primary_muscle === pickGroup || (x.secondary_muscles || '').includes(pickGroup));
  }, [exercises, pickGroup]);

  useEffect(() => {
    if (!selectedId && templates.length) setSelectedId(templates[0].id);
  }, [templates, selectedId]);

  useEffect(() => {
    if (!toast) return;
    const h = setTimeout(() => setToast(''), 2600);
    return () => clearTimeout(h);
  }, [toast]);

  if (tpl.loading || lib.loading || clients.loading) return <PageSkeleton variant="split" label="Loading workout builder" />;
  if (tpl.error) return <ErrorState error={tpl.error} onRetry={tpl.reload} />;

  const startNew = () => {
    setSelectedId(null);
    setEditing({ id: null, name: '', type: 'Push', notes: '', exercises: [emptyEx()] });
  };

  const openTemplate = (t) => {
    setSelectedId(t.id);
    setEditing({ id: t.id, name: t.name, type: t.type || '', notes: t.notes || '',
      exercises: (t.exercises || []).map((e) => ({ ...e, exercise_id: e.exercise_id || null })) });
  };

  const patch = (k, v) => setEditing((e) => ({ ...e, [k]: v }));
  const patchEx = (i, k, v) => setEditing((e) => {
    const ex = e.exercises.map((x, j) => (j === i ? { ...x, [k]: v } : x));
    return { ...e, exercises: ex };
  });
  const addEx = () => setEditing((e) => ({ ...e, exercises: [...e.exercises, emptyEx()] }));
  const removeEx = (i) => setEditing((e) => ({ ...e, exercises: e.exercises.filter((_, j) => j !== i) }));
  const moveEx = (i, dir) => setEditing((e) => {
    const arr = [...e.exercises];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return e;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    return { ...e, exercises: arr };
  });

  const payload = () => ({
    name: editing.name || 'Untitled workout',
    type: editing.type,
    notes: editing.notes,
    exercises: editing.exercises.map((x) => ({
      exercise_id: x.exercise_id || undefined,
      name: x.name,
      sets: Number(x.sets) || 3,
      reps: String(x.reps ?? ''),
      weight: String(x.weight ?? ''),
      rest_sec: Number(x.rest_sec) || 90,
      tempo: x.tempo || undefined,
      notes: x.notes || undefined
    }))
  });

  const saveTemplate = async () => {
    if (!editing?.exercises?.length) return setToast('Add at least one exercise');
    setSaving(true);
    try {
      await api('/workouts/templates', { method: 'POST', body: JSON.stringify(payload()) });
      setToast('Template saved');
      // silent: true -- this page gates its whole render on
      // `tpl.loading || lib.loading || clients.loading` (below); a bare
      // reload() would unmount everything for the duration of the
      // refetch, same class of bug already fixed for Nutrition.jsx.
      await tpl.reload({ silent: true });
      setEditing(null);
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const duplicate = async (id) => {
    await api(`/workouts/templates/${id}/duplicate`, { method: 'POST' });
    setToast('Template duplicated');
    tpl.reload({ silent: true });
  };

  const assign = async () => {
    if (!assignClient) return setToast('Pick a client');
    setSaving(true);
    try {
      await api(`/workouts/clients/${assignClient}/assign`, {
        method: 'POST',
        body: JSON.stringify({ ...payload(), scheduled_date: assignDate || undefined })
      });
      setToast('Workout assigned');
      setAssignOpen(false);
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const onPickMuscle = (group, _muscleId, displayName) => {
    setPickGroup(group);
    setPickLabel(displayName);
  };

  const addFromPicker = (ex) => {
    setEditing((e) => ({ ...e, exercises: [...e.exercises, { ...emptyEx(), exercise_id: ex.id, name: ex.name }] }));
    setToast(`Added ${ex.name}`);
  };

  const addToLibrary = async () => {
    if (!addForm.name || !addForm.primary_muscle) return setToast('Name and muscle are required');
    setAddSaving(true);
    try {
      await api('/workouts/exercises', { method: 'POST', body: JSON.stringify(addForm) });
      setToast('Exercise added to library');
      setAddOpen(false);
      setAddForm({ name: '', primary_muscle: '', equipment: 'BW', difficulty: 'BEGINNER', instructions: '', cues: '', animation_key: '' });
      lib.reload({ silent: true });
    } catch (e) { setToast(e.message); }
    setAddSaving(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-grotesk font-bold text-2xl">Workout builder</h1>
          <p className="text-mute text-sm">Build templates, duplicate them, and assign to clients in one flow.</p>
        </div>
        <button className="btn-primary" onClick={startNew}>+ New template</button>
      </div>

      <div className="grid lg:grid-cols-5 gap-6">
        {/* template list */}
        <Card className="lg:col-span-2 self-start" data-tour="trainer-workouts-templates">
          <Kicker>Your templates</Kicker>
          <div className="space-y-1.5">
            {templates.map((t) => (
              <div key={t.id} className={`rounded-xl border transition-colors ${selectedId === t.id ? 'border-gold/50 bg-tint/[.05]' : 'border-line bg-tint/[.02]'}`}>
                <button className="w-full text-left px-3.5 py-3 flex items-center gap-3" onClick={() => openTemplate(t)}>
                  <div className="flex-1 min-w-0">
                    <div className="font-grotesk text-sm font-semibold truncate">{t.name}</div>
                    <div className="text-[11px] text-mute">{t.type} · {t.exercise_count || 0} exercises</div>
                  </div>
                  <span className="text-mute"><ChevronRightIcon /></span>
                </button>
                <div className="px-3.5 pb-2.5 flex gap-1.5">
                  <button className="btn btn-sm" onClick={() => duplicate(t.id)}>⧉ Duplicate</button>
                  <button className="btn btn-sm" onClick={() => { openTemplate(t); setAssignOpen(true); }}><svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'inline-block', verticalAlign: '-0.125em' }}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg> Assign</button>
                </div>
              </div>
            ))}
            {!templates.length && <Empty title="No templates yet" hint="Create your first workout template to assign it to clients." />}
          </div>
        </Card>

        {/* editor */}
        <Card className="lg:col-span-3">
          <Kicker>{editing?.id ? 'Edit template' : 'New template'}</Kicker>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Name</label>
                  <input className="input" value={editing.name} onChange={(e) => patch('name', e.target.value)} placeholder="Push Day A" />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Type</label>
                  <input className="input" value={editing.type} onChange={(e) => patch('type', e.target.value)} placeholder="Push / Pull / Legs" />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Notes</label>
                  <input className="input" value={editing.notes} onChange={(e) => patch('notes', e.target.value)} placeholder="Optional coaching notes" />
                </div>
              </div>

              <div className="space-y-2">
                {editing.exercises.map((ex, i) => (
                  <div key={i} className="rounded-xl border border-line bg-tint/[.02] p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-md bg-tint/5 border border-line grid place-items-center font-grotesk text-[10px] text-mute shrink-0">{i + 1}</span>
                      <input className="input !py-2 flex-1" value={ex.name} onChange={(e) => patchEx(i, 'name', e.target.value)} placeholder="Exercise name" />
                      <div className="flex gap-1">
                        <button className="btn btn-sm" disabled={i === 0} onClick={() => moveEx(i, -1)} aria-label="Move up">↑</button>
                        <button className="btn btn-sm" disabled={i === editing.exercises.length - 1} onClick={() => moveEx(i, 1)} aria-label="Move down">↓</button>
                        <button className="btn btn-sm !text-bad" onClick={() => removeEx(i)} aria-label="Remove"><XIcon /></button>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <label className="block">
                        <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Sets</span>
                        <input type="number" min="1" className="input !py-1.5" value={ex.sets} onChange={(e) => patchEx(i, 'sets', e.target.value)} />
                      </label>
                      <label className="block">
                        <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Reps</span>
                        <input className="input !py-1.5" value={ex.reps} onChange={(e) => patchEx(i, 'reps', e.target.value)} placeholder="8-10" />
                      </label>
                      <label className="block">
                        <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Weight</span>
                        <input className="input !py-1.5" value={ex.weight} onChange={(e) => patchEx(i, 'weight', e.target.value)} placeholder="60kg / BW" />
                      </label>
                      <label className="block">
                        <span className="text-[9px] uppercase tracking-wider text-faint font-grotesk">Rest s</span>
                        <input type="number" min="0" step="15" className="input !py-1.5" value={ex.rest_sec} onChange={(e) => patchEx(i, 'rest_sec', e.target.value)} />
                      </label>
                    </div>
                    <div className="flex gap-2 items-end">
                      <select className="input !py-1.5 text-xs flex-1" value={ex.exercise_id || ''}
                        onChange={(e) => {
                          const libEx = exercises.find((x) => x.id === e.target.value);
                          patchEx(i, 'exercise_id', e.target.value || null);
                          if (libEx) patchEx(i, 'name', libEx.name || ex.name);
                        }}>
                        <option value="">— link from library (optional) —</option>
                        {exercises.map((x) => <option key={x.id} value={x.id}>{x.name} · {x.primary_muscle}</option>)}
                      </select>
                      <button className="btn btn-sm shrink-0" onClick={() => setAddOpen(true)}>+ New</button>
                    </div>
                  </div>
                ))}
                <div className="flex gap-2">
                  <button className="btn flex-1 !border-dashed" onClick={addEx}>+ Add exercise</button>
                  <button className="btn flex-1 !border-dashed" onClick={() => setPickOpen(true)}>◎ Pick by muscle</button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2 pt-1">
                <button className="btn-primary" onClick={saveTemplate} disabled={saving}>{saving ? 'Saving…' : 'Save template'}</button>
                <button className="btn" onClick={() => setAssignOpen(true)}>Assign to client…</button>
                <button className="btn-ghost btn-sm !text-mute" onClick={() => setEditing(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="text-center py-12 text-mute text-sm">
              Select a template on the left to view it, or press <span className="text-gold">+ New template</span> to build one.
            </div>
          )}
        </Card>
      </div>

      {/* ---- training programs ---- */}
      <Card data-tour="trainer-workouts-programs">
        <div className="flex items-end justify-between flex-wrap gap-3">
          <div>
            <Kicker>Training programs</Kicker>
            <p className="text-mute text-sm">Assign a weekly split to a client — their workout page then serves the right session for each day automatically.</p>
          </div>
          <button className="btn-primary" disabled={!progClient} onClick={() => openProgramModal(currentProg)}>{currentProg ? 'Replace program' : 'Create program'}</button>
        </div>
        <div className="grid sm:grid-cols-[240px_1fr] gap-4 mt-4">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Client</label>
            <select className="input" value={progClient} onChange={(e) => loadProgram(e.target.value)}>
              <option value="">Choose client…</option>
              {clientList.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.goal}</option>)}
            </select>
          </div>
          <div className="rounded-xl border border-line bg-tint/[.02] p-4">
            {!progClient ? (
              <div className="text-center text-mute text-sm py-6">Select a client to see their current program.</div>
            ) : currentProg === null ? (
              <div className="text-center text-mute text-sm py-6">Loading…</div>
            ) : currentProg ? (
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-grotesk font-semibold">{currentProg.name}</span>
                <span className="chip border-gold/30 text-gold">{currentProg.split.replace(/_/g, ' ')}</span>
                <span className="chip border-line text-mute">{currentProg.days_per_week} days / week</span>
                <div className="flex flex-wrap gap-1.5 w-full mt-1">
                  {DOW_ORDER.map((dow) => {
                    const day = currentProg.days.find((d) => d.day_of_week === dow);
                    return (
                      <div key={dow} className={`rounded-lg px-2 py-1.5 text-[10px] font-grotesk font-semibold border ${day ? 'border-gold/40 bg-gold/10 text-gold' : 'border-line text-faint'}`}>
                        {DOW_LABEL[dow]}<span className="block font-normal text-[9px] text-mute">{day ? day.name.split(' ')[0] : 'rest'}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="text-center text-mute text-sm py-4">No program yet — create one to drive this client's daily sessions.</div>
            )}
          </div>
        </div>
      </Card>

      <Modal open={progOpen} onClose={() => setProgOpen(false)} title={currentProg ? 'Replace training program' : 'Create training program'} wide>
        {progForm && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Program name</label>
                <input className="input" value={progForm.name} onChange={(e) => setProgForm((f) => ({ ...f, name: e.target.value }))} placeholder="Push / Pull / Legs" />
              </div>
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Split preset</label>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(SPLIT_PRESETS).map(([s, preset]) => (
                    <button key={s} onClick={() => setProgForm((f) => ({
                      ...f, split: s,
                      days_per_week: preset.daysPerWeek,
                      days: DOW_ORDER.map((dow) => {
                        const ex = preset.days.find((d) => d.dow === dow);
                        return { dow, enabled: !!ex, name: ex?.name || '', focus: ex?.focus || '', template_id: ex ? tplFor(ex.name) : '' };
                      })
                    }))}
                      className={`chip border transition-all ${progForm.split === s ? 'bg-gradient-to-r from-ember to-gold text-bg border-transparent' : 'border-line text-mute'}`}>
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-2">
              {progForm.days.map((d, i) => (
                <div key={d.dow} className={`rounded-xl border p-2.5 transition-colors ${d.enabled ? 'border-gold/30 bg-gold/[.04]' : 'border-line bg-tint/[.01] opacity-70'}`}>
                  <div className="flex items-center gap-2">
                    <input type="checkbox" checked={d.enabled} onChange={(e) => setProgForm((f) => ({ ...f, days: f.days.map((x, j) => j === i ? { ...x, enabled: e.target.checked } : x) }))} className="accent-ember" aria-label={`${DOW_LABEL[d.dow]} enabled`} />
                    <span className="w-9 text-[9px] font-grotesk font-bold text-mute">{DOW_LABEL[d.dow]}</span>
                    <input className="input !py-1.5 !px-2 text-xs flex-1" value={d.name} disabled={!d.enabled}
                      onChange={(e) => setProgForm((f) => ({ ...f, days: f.days.map((x, j) => j === i ? { ...x, name: e.target.value } : x) }))} placeholder="Rest" />
                  </div>
                  {d.enabled && (
                    <div className="flex gap-2 mt-2">
                      <input className="input !py-1.5 !px-2 text-[10px] flex-1" value={d.focus} placeholder="Muscles: CHEST, SHOULDERS"
                        onChange={(e) => setProgForm((f) => ({ ...f, days: f.days.map((x, j) => j === i ? { ...x, focus: e.target.value } : x) }))} />
                      <select className="input !py-1.5 !px-2 text-[10px] w-36 shrink-0" value={d.template_id}
                        onChange={(e) => setProgForm((f) => ({ ...f, days: f.days.map((x, j) => j === i ? { ...x, template_id: e.target.value } : x) }))}>
                        <option value="">No template</option>
                        {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <button className="btn-primary flex-1" onClick={saveProgram} disabled={progSaving || !progForm.days.some((d) => d.enabled)}>
                {progSaving ? 'Saving…' : 'Assign program'}
              </button>
              <button className="btn" onClick={() => setProgOpen(false)}>Cancel</button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={assignOpen} onClose={() => setAssignOpen(false)} title={`Assign "${editing?.name || 'workout'}"`}>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Client</label>
            <select className="input" value={assignClient} onChange={(e) => setAssignClient(e.target.value)}>
              <option value="">Choose client…</option>
              {clientList.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.goal}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Schedule date (optional)</label>
            <input type="date" className="input" value={assignDate} onChange={(e) => setAssignDate(e.target.value)} />
          </div>
          <button className="btn-primary w-full" onClick={assign} disabled={saving}>{saving ? 'Assigning…' : 'Assign workout'}</button>
        </div>
      </Modal>

      <Modal open={pickOpen} onClose={() => { setPickOpen(false); setPickGroup(null); }} title="Pick an exercise by muscle" wide>
        <div className="grid sm:grid-cols-2 gap-4">
          <MuscleBody3D selectedGroup={pickGroup} onSelect={onPickMuscle} height={380} />
          <div className="min-w-0">
            <Kicker>{pickGroup ? `${pickLabel} · ${pickMatches.length} exercises` : 'Select a muscle'}</Kicker>
            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {pickMatches.map((ex) => (
                <button key={ex.id} type="button" onClick={() => addFromPicker(ex)}
                  className="w-full text-left px-3 py-2.5 rounded-xl border border-line bg-tint/[.02] hover:bg-tint/[.05] hover:border-gold/40 transition-colors flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-grotesk text-sm font-semibold truncate">{ex.name}</span>
                    <span className="block text-[10px] text-mute">{ex.primary_muscle} · {ex.equipment}</span>
                  </span>
                  <span className="text-mute shrink-0">+</span>
                </button>
              ))}
              {pickGroup && !pickMatches.length && (
                <div className="text-center py-8 text-mute text-sm">No exercises tagged {pickLabel} yet.</div>
              )}
              {!pickGroup && (
                <div className="text-center py-8 text-mute text-sm">Rotate the model or tap a muscle chip to see matching exercises.</div>
              )}
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add exercise to library">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Exercise name*</label>
              <input className="input" value={addForm.name} onChange={(e) => setAddForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Cable Crossover" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Primary muscle*</label>
              <input className="input" value={addForm.primary_muscle} onChange={(e) => setAddForm((f) => ({ ...f, primary_muscle: e.target.value }))} placeholder="Chest" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Equipment</label>
              <input className="input" value={addForm.equipment} onChange={(e) => setAddForm((f) => ({ ...f, equipment: e.target.value }))} placeholder="Cable" />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Difficulty</label>
              <select className="input" value={addForm.difficulty} onChange={(e) => setAddForm((f) => ({ ...f, difficulty: e.target.value }))}>
                <option>BEGINNER</option>
                <option>INTERMEDIATE</option>
                <option>ADVANCED</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Animation key</label>
              <input className="input" value={addForm.animation_key} onChange={(e) => setAddForm((f) => ({ ...f, animation_key: e.target.value }))} placeholder="bench_press / squat / fallback" />
            </div>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Instructions / coaching cues</label>
            <textarea className="input" rows={3} value={addForm.instructions} onChange={(e) => setAddForm((f) => ({ ...f, instructions: e.target.value }))} />
          </div>
          <div className="flex gap-2">
            <button className="btn-primary flex-1" onClick={addToLibrary} disabled={addSaving}>{addSaving ? 'Adding…' : 'Add to library'}</button>
            <button className="btn" onClick={() => setAddOpen(false)}>Cancel</button>
          </div>
        </div>
      </Modal>

      {toast && <div className="toast anim-toast">{toast}</div>}
    </div>
  );
}
