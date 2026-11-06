/**
 * TEMPLATE LIST — findable, not just listed.
 *
 * WHAT THIS REPLACES. Every template rendered as an identical row, newest
 * first, forever. That is fine at six templates and unusable at forty:
 * the only way to find "the leg day with hip thrusts in it" was to open
 * templates one at a time and read them.
 *
 * Three things fix that, and they are the three things a trainer actually
 * does with this list:
 *
 *  1. SEARCH INCLUDES THE EXERCISES. The list endpoint already returns
 *     every template's exercises, so searching "hip thrust" finds the
 *     session that contains one -- not just templates with "hip" in the
 *     title. This is the whole reason search is worth having here; a
 *     name-only search would be a slower way of reading the list.
 *  2. FILTER BY TYPE, FROM THE DATA. The chips are built from the types
 *     that exist in THIS trainer's templates. No fixed taxonomy, because
 *     the type field is free text and a hard-coded Push/Pull/Legs list
 *     would hide anything named differently.
 *  3. SORT, including by size -- "which of my sessions have got too
 *     long" is a real programming question.
 *
 * Each card also previews what is inside it. A name and a count ("5
 * exercises") does not distinguish two leg days; the first few movements
 * do.
 */
import { useMemo, useState } from 'react';
import { Empty } from '../UI.jsx';
import { prettyName } from './ExercisePicker.jsx';
import Select from '../Select.jsx';

const SORTS = [
  ['recent', 'Recent'],
  ['name', 'A-Z'],
  ['size', 'Longest'],
];

/** Search text is normalised the way the SCREEN spells things, not the
 *  way the database does. Exercise names are stored as slugs
 *  (front_squat) and rendered prettified (Front Squat), so matching the
 *  raw value meant a trainer could read "Front Squat" off a card, type
 *  exactly that, and be told nothing matched. Separators collapse to
 *  spaces on both sides of the comparison. */
function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** The searchable text of a template: its name, its type, and the names
 *  of everything in it. */
function haystack(t) {
  return [
    t.name,
    t.type,
    ...(t.exercises || []).map((x) => x.name),
  ].filter(Boolean).map(normalise).join(' ');
}

export default function TemplateList({
  templates, selectedId, onOpen, onDuplicate, onAssign, onDelete,
}) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [sort, setSort] = useState('recent');

  // Types present in the real data, most-used first, capped so the filter
  // row never becomes its own scrolling problem.
  const types = useMemo(() => {
    const counts = new Map();
    for (const t of templates) {
      const key = String(t.type || '').trim();
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 6);
  }, [templates]);

  const shown = useMemo(() => {
    const q = normalise(query);
    let list = templates;
    if (type) list = list.filter((t) => String(t.type || '').trim() === type);
    if (q) list = list.filter((t) => haystack(t).includes(q));
    const sorted = [...list];
    if (sort === 'name') sorted.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    else if (sort === 'size') sorted.sort((a, b) => (b.exercises?.length || 0) - (a.exercises?.length || 0));
    // 'recent' is the order the API already returns (created_at DESC).
    return sorted;
  }, [templates, query, type, sort]);

  const filtering = Boolean(query.trim() || type);

  if (!templates.length) {
    return <Empty icon="strength" title="No templates yet" hint="Build one once, assign it to any client." />;
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search templates or exercises"
        aria-label="Search templates or exercises"
        className="input w-full"
        type="search"
      />

      {/* Type filters as pills, sort as one compact menu: two rows of
          small chips read as clutter before a single template was seen. */}
      <div className="flex items-center gap-2 mt-3">
        {types.length > 1 ? (
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar flex-1 min-w-0 pr-6" style={{ maskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)', WebkitMaskImage: 'linear-gradient(to right, #000 calc(100% - 28px), transparent)' }}>
            <Chip on={!type} onClick={() => setType('')}>All</Chip>
            {types.map(([value, n]) => (
              <Chip key={value} on={type === value} onClick={() => setType(type === value ? '' : value)}>
                {prettyName(value)} <span style={{ opacity: 0.6 }}>{n}</span>
              </Chip>
            ))}
          </div>
        ) : <div className="flex-1" />}
        <div className="w-[128px] shrink-0">
          <Select aria-label="Sort templates" value={sort} onChange={setSort} options={SORTS.map(([value, label]) => ({ value, label }))} />
        </div>
      </div>

      {/* Saying how many matched is what makes a filter trustworthy -- a
          short list with no count reads as "that is all you have". */}
      {filtering && (
        <div className="text-[13px] mt-3 px-0.5" style={{ color: 'var(--mute)' }}>
          {shown.length} of {templates.length} templates
        </div>
      )}

      <div className="mt-3 -mx-5 sm:-mx-6" style={{ borderTop: '1px solid var(--line)' }}>
        {shown.map((t) => (
          <TemplateRow
            key={t.id}
            t={t}
            selected={selectedId === t.id}
            onOpen={() => onOpen(t)}
            onDuplicate={() => onDuplicate(t.id)}
            onAssign={() => onAssign(t)}
            onDelete={() => onDelete(t)}
          />
        ))}

        {/* "Nothing matched" is a different situation from "you have
            nothing", and it comes with the way out. */}
        {!shown.length && (
          <div className="py-8 text-center">
            <div className="text-[15px] font-semibold" style={{ color: 'var(--ink)' }}>
              No templates match {query.trim() ? `"${query.trim()}"` : `"${prettyName(type)}"`}
            </div>
            <button
              type="button"
              onClick={() => { setQuery(''); setType(''); }}
              className="text-[14px] mt-1.5 font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* One template as a list row: its name, what is in it, how long it is.
   Duplicate / Assign / Delete belong to the template you are looking at,
   so they appear on the selected row only -- every row carrying all three
   (one of them a red box) made the list look like a wall of warnings. */
function TemplateRow({ t, selected, onOpen, onDuplicate, onAssign, onDelete }) {
  const exercises = t.exercises || [];
  const preview = exercises.slice(0, 3).map((x) => prettyName(x.name)).filter(Boolean);
  const more = exercises.length - preview.length;
  return (
    <div style={{ borderBottom: '1px solid var(--line)', background: selected ? 'rgb(var(--accent-rgb) / .1)' : undefined }}>
      <button type="button" onClick={onOpen} aria-current={selected ? 'true' : undefined}
        className="w-full text-left flex items-center gap-3 px-5 sm:px-6 py-3.5 transition-colors hover:bg-[var(--bg2)]">
        <span className="flex-1 min-w-0">
          <span className="block text-[15px] font-semibold truncate" style={{ color: 'var(--ink)' }}>{t.name}</span>
          {preview.length > 0 && (
            <span className="block text-[13px] mt-0.5 truncate" style={{ color: 'var(--mute)' }}>
              {preview.join(' · ')}{more > 0 ? ` +${more}` : ''}
            </span>
          )}
        </span>
        <span className="text-[13px] tabular-nums shrink-0" style={{ color: 'var(--faint)' }}>
          {exercises.length || t.exercise_count || 0} exercises
        </span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--faint)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0"><path d="m9 18 6-6-6-6" /></svg>
      </button>
      {selected && (
        <div className="flex items-center gap-1 px-4 sm:px-5 pb-2.5 -mt-1">
          <Action onClick={onAssign} label={`Assign ${t.name}`}>Assign</Action>
          <Action onClick={onDuplicate} label={`Duplicate ${t.name}`}>Duplicate</Action>
          <Action onClick={onDelete} label={`Delete ${t.name}`} danger>Delete</Action>
        </div>
      )}
    </div>
  );
}

function Chip({ children, on, onClick }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      className="rounded-full font-semibold shrink-0 px-3.5 text-[13px] whitespace-nowrap"
      style={{
        minHeight: 36,
        background: on ? 'var(--ink)' : 'rgb(var(--tint-rgb) / .07)',
        color: on ? 'var(--bg)' : 'var(--mute)',
      }}
    >{children}</button>
  );
}

function Action({ children, onClick, label, danger }) {
  return (
    <button
      type="button" onClick={onClick} aria-label={label}
      className={`rounded-lg px-3 text-[14px] font-semibold ${danger ? 'ml-auto' : ''}`}
      style={{ minHeight: 40, color: danger ? 'var(--bad)' : 'var(--accent)' }}
    >{children}</button>
  );
}
