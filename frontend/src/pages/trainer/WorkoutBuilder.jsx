import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import ExercisePicker, { prettyName } from '../../components/trainer/ExercisePicker.jsx';
import ExerciseCard, { prescriptionLine } from '../../components/trainer/ExerciseCard.jsx';
import TemplateList from '../../components/trainer/TemplateList.jsx';
import AssignPreview from '../../components/trainer/AssignPreview.jsx';
import { useFetch } from '../../utils.js';
import { Card, Kicker, ErrorState, Modal, PageSkeleton, CheckIcon } from '../../components/UI.jsx';
import MuscleBody3D from '../../components/anatomy/MuscleBody3D.jsx';

const emptyEx = () => ({ exercise_id: null, name: '', sets: 3, reps: '10', weight: 'BW', rest_sec: 90, tempo: '', notes: '' });

/**
 * Type-ahead link to the exercise library — replaces a 280+ option <select>.
 * Alias-aware server search (GET /workouts/exercises, the same endpoint the
 * client planner uses). Muscle-group browsing stays in the "◎ Pick by muscle"
 * 3D modal, so this control stays a single uncluttered field.
 */
function LibraryCombobox({ value, name, onSelect }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const cache = useRef(new Map());

  useEffect(() => {
    const term = q.trim();
    if (!open || term.length < 1) { setRows([]); setLoading(false); return undefined; }
    if (cache.current.has(term.toLowerCase())) { setRows(cache.current.get(term.toLowerCase())); return undefined; }
    setLoading(true);
    const h = setTimeout(async () => {
      try {
        const r = await api(`/workouts/exercises?q=${encodeURIComponent(term)}`);
        const list = (r.exercises || []).slice(0, 25);
        cache.current.set(term.toLowerCase(), list);
        setRows(list);
      } catch { setRows([]); } finally { setLoading(false); }
    }, 220);
    return () => clearTimeout(h);
  }, [q, open]);

  return (
    <div className="relative flex-1">
      <input
        className="input !py-1.5 text-xs w-full"
        placeholder="Link from library (type to search)"
        value={open ? q : (value && name ? name : q)}
        onFocus={() => { setOpen(true); setQ(''); }}
        onChange={(e) => setQ(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {/* The check now lives here, as a real icon next to the value
          rather than concatenated INTO the text -- a glyph baked into a
          string can't be positioned, sized, or coloured independently of
          the name it's stuck to. */}
      {value && !open && name && (
        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'rgb(var(--good-rgb))' }}>
          <CheckIcon />
        </span>
      )}
      {value && !open && (
        <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-mute hover:text-bad"
          onMouseDown={(e) => { e.preventDefault(); onSelect(null); }}>clear</button>
      )}
      {open && (q.trim() || loading) && (
        <div className="absolute z-20 mt-1 w-full max-h-52 overflow-y-auto rounded-lg border border-line bg-bg shadow-lg">
          {loading && <div className="px-3 py-2 text-[10px] text-mute">Searching…</div>}
          {!loading && !rows.length && <div className="px-3 py-2 text-[10px] text-mute">No matches</div>}
          {rows.map((x) => (
            <button key={x.id} type="button"
              className="w-full text-left px-3 py-2 hover:bg-tint/[.08] border-b border-line/40 last:border-0"
              onMouseDown={(e) => { e.preventDefault(); onSelect(x); setOpen(false); setQ(''); }}>
              <span className="block text-[12px] font-grotesk font-semibold truncate">{x.name}</span>
              <span className="text-[9px] text-mute">{x.primary_muscle}{x.equipment ? ` · ${x.equipment}` : ''}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

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
  const clients = useFetch(() => api('/clients?sort=name'));
  // The full exercise library (287 rows, ~128KB) is ONLY used by the "pick
  // by muscle" 3D picker below (pickMatches) — everything else on this page
  // (the "link from library" combobox) uses the debounced, capped
  // /workouts/exercises?q= search instead. Loading all 287 rows eagerly on
  // every page mount used to block the entire page behind a 128KB response
  // it usually never needs; deferred until the picker is actually opened.
  const [pickerEverOpened, setPickerEverOpened] = useState(false);
  const lib = useFetch(
    () => (pickerEverOpened ? api('/workouts/exercises') : Promise.resolve({ exercises: [] })),
    [pickerEverOpened]
  );

  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(null); // draft {id?, name, type, notes, exercises[]}
  // The new picker stays OPEN while exercises are added, so it needs to
  // report how many landed -- that count is the only feedback a
  // trainer gets in place of the sheet closing.
  const [libOpen, setLibOpen] = useState(false);
  const [addedThisSession, setAddedThisSession] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  /* UNSAVED WORK IS THE EXPENSIVE THING ON THIS SCREEN. Clicking another
     template in the list silently replaced the draft -- ten minutes of
     programming gone with no warning and no undo. This holds a snapshot
     of the draft as it was last loaded or saved; anything that would
     discard the draft compares against it first. */
  const baseline = useRef('');
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

  // lib.loading is intentionally excluded: it only feeds the muscle-picker
  // modal (opened on demand, see pickerEverOpened above), not the main page
  // -- including it here would reintroduce exactly the eager-load cost that
  // gating the fetch on pickerEverOpened was meant to remove.
  /* What "unchanged" means. Compared as a normalised string rather than
     by reference, because every keystroke replaces the draft object --
     an identity check would call an untouched draft dirty. */
  const snapshot = (draft) => (draft ? JSON.stringify({
    id: draft.id || null,
    name: draft.name || '',
    type: draft.type || '',
    notes: draft.notes || '',
    exercises: (draft.exercises || []).map((x) => [
      x.exercise_id || null, x.name || '', String(x.sets ?? ''), String(x.reps ?? ''),
      String(x.weight ?? ''), String(x.rest_sec ?? ''), x.notes || '',
    ]),
  }) : '');

  const isDirty = () => Boolean(editing) && snapshot(editing) !== baseline.current;

  /* Closing the tab mid-draft gets the browser's own warning. The
     message is the browser's, not ours -- Chrome has ignored custom text
     for years, and pretending otherwise would be writing a string nobody
     will ever read.

     NOTE: this effect, and the two helpers above it, sit ABOVE the
     loading/error early returns on purpose. Hooks cannot live below a
     conditional return -- placed there, this one is skipped on the
     loading render and present on the next, which React rejects outright
     ("Rendered more hooks than during the previous render") and takes the
     whole screen down with it. */
  useEffect(() => {
    const onBeforeUnload = (e) => {
      if (!isDirty()) return undefined;
      e.preventDefault();
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  });

  if (tpl.loading || clients.loading) return <PageSkeleton variant="split" label="Loading workout builder" />;
  if (tpl.error) return <ErrorState error={tpl.error} onRetry={tpl.reload} />;


  /* One gate in front of everything that throws the draft away. It names
     the template at risk, because "you have unsaved changes" is useless
     when a trainer has several on the go. */
  const confirmDiscard = () => {
    if (!isDirty()) return true;
    const what = editing.name?.trim() || 'this new template';
    return window.confirm(`Discard your unsaved changes to "${what}"?`);
  };

  const load = (draft, id) => {
    baseline.current = snapshot(draft);
    setSelectedId(id);
    setEditing(draft);
  };

  const startNew = () => {
    if (!confirmDiscard()) return;
    load({ id: null, name: '', type: 'Push', notes: '', exercises: [emptyEx()] }, null);
  };

  const openTemplate = (t) => {
    // Reopening the template already being edited must not offer to
    // discard it -- that is not navigating away, it is a no-op.
    if (t.id === selectedId && editing?.id === t.id) return;
    if (!confirmDiscard()) return;
    load({ id: t.id, name: t.name, type: t.type || '', notes: t.notes || '',
      exercises: (t.exercises || []).map((e) => ({ ...e, exercise_id: e.exercise_id || null })) }, t.id);
  };


  const patch = (k, v) => setEditing((e) => ({ ...e, [k]: v }));

  /* Adding from the library. Defaults are stated once here rather than
     left blank: an exercise with no prescription is not a programmed
     exercise, and making the trainer type 4/8/90 for every single
     movement is exactly the repetition this redesign exists to remove.
     They are ordinary starting values, immediately editable. */
  const addFromLibrary = (x) => {
    setEditing((e) => ({
      ...e,
      exercises: [
        ...(e.exercises || []).filter((ex) => String(ex.name || '').trim() || ex.exercise_id),
        { exercise_id: x.id || null, name: x.name || '', sets: 4, reps: '8', weight: '', rest_sec: 90, notes: '' },
      ],
    }));
    setAddedThisSession((n) => n + 1);
  };

  const duplicateEx = (i) => setEditing((e) => {
    const copy = { ...e.exercises[i] };
    const next = [...e.exercises];
    next.splice(i + 1, 0, copy);
    return { ...e, exercises: next };
  });
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
    // A named exercise is the one thing the backend cannot default, so it
    // is checked HERE with a message naming the offender -- rather than
    // letting the request fail and returning "Invalid workout data".
    const blank = editing.exercises.findIndex((x) => !String(x.name || '').trim());
    if (blank !== -1) return setToast(`Exercise ${blank + 1} still needs a name`);
    if (saving) return;   // a second tap must not create a second template
    setSaving(true);
    try {
      /* EDITING AN EXISTING TEMPLATE UPDATES IT.
         This always POSTed, even with editing.id set -- so "editing" Legs
         B created a SECOND Legs B and threw the change away. Three edits
         produced four templates and no saved work. PUT is the fix; the
         endpoint did not exist until now either. */
      let savedId = editing.id;
      if (editing.id) {
        await api(`/workouts/templates/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload()) });
        setToast('Template updated');
      } else {
        const created = await api('/workouts/templates', { method: 'POST', body: JSON.stringify(payload()) });
        savedId = created?.id || null;
        setToast('Template saved');
      }
      // silent: true -- this page gates its whole render on
      // `tpl.loading || lib.loading || clients.loading` (below); a bare
      // reload() would unmount everything for the duration of the
      // refetch, same class of bug already fixed for Nutrition.jsx.
      await tpl.reload({ silent: true });
      /* STAY ON WHAT WAS JUST SAVED. Saving used to close the editor
         outright, which threw the trainer back to an empty pane and made
         "save, look at it, adjust one number" a three-click round trip.
         The draft is now simply no longer dirty: same template, same
         scroll position, nothing to discard. */
      setSelectedId(savedId);
      setEditing((draft) => {
        const settled = draft ? { ...draft, id: savedId } : draft;
        baseline.current = snapshot(settled);
        return settled;
      });
    } catch (e) { setToast(e.message); }
    setSaving(false);
  };

  const duplicate = async (id) => {
    try {
      await api(`/workouts/templates/${id}/duplicate`, { method: 'POST' });
      setToast('Template duplicated');
      tpl.reload({ silent: true });
    } catch (e) { setToast(e.message || 'Could not duplicate that template'); }
  };

  /* Deleting a template does NOT touch workouts already assigned from it
     -- those are what a client was actually given, and the backend only
     removes rows carrying this template_id. The confirm says so, because
     "will this wipe my clients' sessions?" is the question a trainer
     actually has at this moment. */
  const removeTemplate = async (t) => {
    const ok = window.confirm(
      `Delete "${t.name}"?\n\nWorkouts already assigned to clients from this template are kept.`);
    if (!ok) return;
    try {
      await api(`/workouts/templates/${t.id}`, { method: 'DELETE' });
      setToast('Template deleted');
      if (editing?.id === t.id) setEditing(null);
      tpl.reload({ silent: true });
    } catch (e) { setToast(e.message || 'Could not delete that template'); }
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
          <TemplateList
            templates={templates}
            selectedId={selectedId}
            onOpen={openTemplate}
            onDuplicate={duplicate}
            onAssign={(t) => { openTemplate(t); setAssignOpen(true); }}
            onDelete={removeTemplate}
          />
        </Card>

        {/* editor */}
        <Card className="lg:col-span-3">
          <Kicker>{editing?.id ? 'Edit template' : 'New template'}</Kicker>
          {editing ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Name</label>
                  <input className="input" value={editing.name} onChange={(e) => patch('name', e.target.value)} placeholder="Push Day A" aria-label="Template name" />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Type</label>
                  <input className="input" value={editing.type} onChange={(e) => patch('type', e.target.value)} placeholder="Push / Pull / Legs" aria-label="Template type" />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-mute font-grotesk mb-1">Notes</label>
                  <input className="input" value={editing.notes} onChange={(e) => patch('notes', e.target.value)} placeholder="Optional coaching notes" aria-label="Template notes" />
                </div>
              </div>

              <div className="space-y-2">
                {editing.exercises.map((ex, i) => (
                  <ExerciseCard
                    key={i}
                    ex={ex}
                    index={i}
                    total={editing.exercises.length}
                    onChange={(next) => setEditing((e) => ({
                      ...e, exercises: e.exercises.map((x, j) => (j === i ? next : x)),
                    }))}
                    onRemove={() => removeEx(i)}
                    onDuplicate={() => duplicateEx(i)}
                    onMove={(dir) => moveEx(i, dir)}
                  />
                ))}
                {/* One primary way in. "Add exercise" opens the library and
                    keeps it open; the old pair of dashed buttons offered two
                    routes to the same outcome and made neither obvious. */}
                <button
                  className="btn w-full !border-dashed"
                  onClick={() => { setAddedThisSession(0); setLibOpen(true); }}
                >
                  + Add exercise
                </button>
              </div>

              {/* A session at a glance. Sets are counted, not estimated --
                  there is no duration guess here because nothing in this
                  data supports one, and a made-up "45-60 min" would be a
                  number a trainer might actually plan around. */}
              {editing.exercises.length > 0 && (
                <div
                  className="rounded-xl px-3 py-2.5 flex items-center gap-4 flex-wrap tabular-nums"
                  style={{ background: 'var(--bg)', border: '1px solid var(--line)' }}
                >
                  <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
                    <strong>{editing.exercises.length}</strong>
                    <span style={{ color: 'var(--mute)' }}> {editing.exercises.length === 1 ? 'exercise' : 'exercises'}</span>
                  </span>
                  <span className="text-[12px]" style={{ color: 'var(--ink)' }}>
                    <strong>{editing.exercises.reduce((n, x) => n + (Number(x.sets) || 0), 0)}</strong>
                    <span style={{ color: 'var(--mute)' }}> sets</span>
                  </span>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <button className="btn-primary" onClick={saveTemplate} disabled={saving}>
                  {saving ? 'Saving…' : editing.id ? 'Update template' : 'Save template'}
                </button>
                {/* Seeing the session the way the client receives it,
                    before sending it. The editor is a form; this is the
                    workout. */}
                <button className="btn" onClick={() => setPreviewOpen(true)}>Preview</button>
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

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={editing?.name?.trim() || 'Untitled workout'}
        sub={[editing?.type, `${editing?.exercises?.length || 0} exercises`,
          `${(editing?.exercises || []).reduce((n, x) => n + (Number(x.sets) || 0), 0)} sets`]
          .filter(Boolean).join(' · ')}
      >
        <div className="space-y-2">
          {editing?.notes?.trim() && (
            <div
              className="rounded-xl px-3 py-2.5 text-[12px]"
              style={{ background: 'var(--bg)', border: '1px solid var(--line)', color: 'var(--mute)' }}
            >
              {editing.notes}
            </div>
          )}
          {(editing?.exercises || []).map((ex, i) => (
            <div
              key={i}
              className="rounded-xl px-3 py-2.5 flex items-start gap-3"
              style={{ background: 'var(--panel)', border: '1px solid var(--line)' }}
            >
              <span
                className="shrink-0 tabular-nums text-[11px] font-bold rounded-lg grid place-items-center"
                style={{ width: 26, height: 26, background: 'var(--bg)', color: 'var(--mute)' }}
              >
                {String(i + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-bold" style={{ color: 'var(--ink)' }}>
                  {prettyName(ex.name) || 'Unnamed exercise'}
                </div>
                <div className="text-[11.5px] mt-0.5 tabular-nums" style={{ color: 'var(--mute)' }}>
                  {prescriptionLine(ex) || 'No prescription set'}
                </div>
                {ex.notes?.trim() && (
                  <div className="text-[11px] mt-1" style={{ color: 'var(--mute)' }}>“{ex.notes}”</div>
                )}
              </div>
            </div>
          ))}
        </div>
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
          {/* Chosen client + this template's exercises = the one place
              previous performance is both knowable and useful. */}
          <AssignPreview clientId={assignClient} exercises={editing?.exercises || []} />
          <button className="btn-primary w-full" onClick={assign} disabled={saving}>{saving ? 'Assigning…' : 'Assign workout'}</button>
        </div>
      </Modal>

      <Modal open={pickOpen} onClose={() => { setPickOpen(false); setPickGroup(null); }} title="Pick an exercise by muscle" wide>
        <div className="grid sm:grid-cols-2 gap-4">
          <MuscleBody3D selectedGroup={pickGroup} onSelect={onPickMuscle} height={380} />
          <div className="min-w-0">
            <Kicker>{lib.loading ? 'Loading exercise library…' : pickGroup ? `${pickLabel} · ${pickMatches.length} exercises` : 'Select a muscle'}</Kicker>
            <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
              {lib.loading && <div className="text-center py-8 text-mute text-sm">Loading exercise library…</div>}
              {!lib.loading && pickMatches.map((ex) => (
                <button key={ex.id} type="button" onClick={() => addFromPicker(ex)}
                  className="w-full text-left px-3 py-2.5 rounded-xl border border-line bg-tint/[.02] hover:bg-tint/[.05] hover:border-gold/40 transition-colors flex items-center justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-grotesk text-sm font-semibold truncate">{ex.name}</span>
                    <span className="block text-[10px] text-mute">{ex.primary_muscle} · {ex.equipment}</span>
                  </span>
                  <span className="text-mute shrink-0">+</span>
                </button>
              ))}
              {!lib.loading && pickGroup && !pickMatches.length && (
                <div className="text-center py-8 text-mute text-sm">No exercises tagged {pickLabel} yet.</div>
              )}
              {!lib.loading && !pickGroup && (
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

      <ExercisePicker
        open={libOpen}
        addedCount={addedThisSession}
        onClose={() => setLibOpen(false)}
        onAdd={addFromLibrary}
        onOpenMuscleMap={() => {
          // Hand over rather than stack: two open sheets would leave the
          // trainer unsure which one the next tap belongs to.
          setLibOpen(false);
          setPickerEverOpened(true);   // this is what triggers the library fetch
          setPickOpen(true);
        }}
      />
      {toast && <div className="toast anim-toast">{toast}</div>}
    </div>
  );
}
