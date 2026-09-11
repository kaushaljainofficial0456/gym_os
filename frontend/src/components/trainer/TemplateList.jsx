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
    return <Empty title="No templates yet" hint="Create your first workout template to assign it to clients." />;
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search templates or exercises"
        aria-label="Search templates or exercises"
        className="input w-full text-[13px]"
        style={{ minHeight: 42 }}
      />

      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
        {types.length > 1 && (
          <>
            <Chip on={!type} onClick={() => setType('')}>All</Chip>
            {types.map(([value, n]) => (
              <Chip key={value} on={type === value} onClick={() => setType(type === value ? '' : value)}>
                {prettyName(value)} <span style={{ opacity: 0.6 }}>{n}</span>
              </Chip>
            ))}
          </>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {SORTS.map(([value, label]) => (
            <Chip key={value} on={sort === value} onClick={() => setSort(value)} small>{label}</Chip>
          ))}
        </div>
      </div>

      {/* Saying how many matched is what makes a filter trustworthy -- a
          short list with no count reads as "that is all you have". */}
      {filtering && (
        <div className="text-[11px] mt-2.5 px-0.5" style={{ color: 'var(--mute)' }}>
          {shown.length} of {templates.length} templates
        </div>
      )}

      <div className="space-y-1.5 mt-2.5">
        {shown.map((t) => (
          <TemplateCard
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
            <div className="text-[12.5px] font-semibold" style={{ color: 'var(--ink)' }}>
              No templates match {query.trim() ? `"${query.trim()}"` : `"${prettyName(type)}"`}
            </div>
            <button
              type="button"
              onClick={() => { setQuery(''); setType(''); }}
              className="text-[11.5px] mt-1.5 font-semibold"
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

function TemplateCard({ t, selected, onOpen, onDuplicate, onAssign, onDelete }) {
  const exercises = t.exercises || [];
  // Three names, then a count. Enough to tell two leg days apart without
  // turning the list into the templates themselves.
  const preview = exercises.slice(0, 3).map((x) => prettyName(x.name)).filter(Boolean);
  const more = exercises.length - preview.length;

  return (
    <div
      className="rounded-xl transition-colors"
      style={{
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
        background: selected ? 'var(--accent-soft)' : 'var(--panel)',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className="w-full text-left px-3.5 pt-3 pb-2"
      >
        <div className="flex items-baseline gap-2">
          <div className="font-grotesk text-[13.5px] font-semibold truncate flex-1" style={{ color: 'var(--ink)' }}>
            {t.name}
          </div>
          <div className="text-[10.5px] tabular-nums shrink-0" style={{ color: 'var(--mute)' }}>
            {exercises.length || t.exercise_count || 0} ex
          </div>
        </div>
        {preview.length > 0 && (
          <div className="text-[11px] mt-1 truncate" style={{ color: 'var(--mute)' }}>
            {preview.join(' · ')}{more > 0 ? ` +${more} more` : ''}
          </div>
        )}
      </button>

      <div className="px-3.5 pb-2.5 flex gap-1.5 flex-wrap">
        <Action onClick={onDuplicate} label={`Duplicate ${t.name}`}>Duplicate</Action>
        <Action onClick={onAssign} label={`Assign ${t.name}`}>Assign</Action>
        <Action onClick={onDelete} label={`Delete ${t.name}`} danger>Delete</Action>
      </div>
    </div>
  );
}

function Chip({ children, on, onClick, small }) {
  return (
    <button
      type="button" onClick={onClick} aria-pressed={on}
      className={`rounded-lg font-semibold shrink-0 ${small ? 'px-2 text-[10.5px]' : 'px-2.5 text-[11px]'}`}
      style={{
        minHeight: small ? 28 : 30,
        background: on ? 'var(--accent-soft)' : 'transparent',
        border: `1px solid ${on ? 'var(--accent)' : 'var(--line)'}`,
        color: on ? 'var(--accent)' : 'var(--mute)',
      }}
    >{children}</button>
  );
}

function Action({ children, onClick, label, danger }) {
  return (
    <button
      type="button" onClick={onClick} aria-label={label}
      className="rounded-lg px-2.5 text-[11px] font-semibold"
      style={{
        minHeight: 32,
        border: '1px solid var(--line)',
        color: danger ? 'var(--bad)' : 'var(--mute)',
      }}
    >{children}</button>
  );
}
