/**
 * THE SUMMARY. One view for the app and for the public QR page: the person
 * who took part sees themselves first, and everyone sees the winners.
 */
import { useMemo, useState } from 'react';
import {
  Award, Calculator, Crown, Flame, Gauge, Layers, Scale, Share2, Skull, Smile, Sparkles, Swords, Target, TrendingUp, Trophy, UserRound, Users,
} from './icons.jsx';
import { COMPARE_ICON, EVENT_COLORS, eventIcon, eventStyle, ordinal, PhaseChip } from './shared.jsx';
import { CompetitionRings, DotStrip, GradientRing, GymWar, Medal, Podium, Radar, RankBars } from './visuals.jsx';

const Kpi = ({ icon: Icon, value, label }) => (
  <div className="tr-kpi"><Icon size={17} /><strong>{value}</strong><span>{label}</span></div>
);

function Comparisons({ items }) {
  if (!items?.length) return null;
  return (
    <div className="tr-compare">
      {items.map((c) => {
        const Icon = COMPARE_ICON[c.icon] || Sparkles;
        return <div key={c.text} className="tr-compare-row"><span className="tr-compare-icon"><Icon size={18} /></span>{c.text}</div>;
      })}
    </div>
  );
}

function Line({ lines, savage }) {
  if (!lines) return null;
  const Icon = savage ? Skull : Smile;
  return <div className="tr-line"><Icon size={18} /><span>{savage ? lines.savage : lines.friendly}</span></div>;
}

/** What this place means, in words. Winning is whatever the host set it to. */
const verdict = (e) => {
  if (e.rank === 1) return 'Winner';
  if (e.winner) return `Winner · ${ordinal(e.rank)} place`;
  return `${ordinal(e.rank)} place`;
};

/** The one concrete thing to do next time. */
function nextTime(e) {
  if (!e.next_target) return e.rank === 1 ? 'Next time: defend it.' : null;
  const faster = e.metric === 'time_low';
  return `Next time: ${e.next_target.gap} ${faster ? 'faster' : 'more'} takes ${ordinal(e.next_target.place)} place from ${e.next_target.name}.`;
}

function MyEvent({ e, index, savage }) {
  const Icon = eventIcon(e);
  const style = eventStyle(index);
  const [a, b] = EVENT_COLORS[index % EVENT_COLORS.length];
  if (e.rank == null) {
    return (
      <div className="tr-panel tr-row" style={style}>
        <span className="tr-event-icon"><Icon size={20} /></span>
        <div className="tr-grow"><b style={{ color: 'var(--ink)', fontSize: 16 }}>{e.name}</b><div className="tr-faint">No score recorded</div></div>
      </div>
    );
  }
  const stats = [
    e.vs_average ? { value: `${e.vs_average > 0 ? '+' : ''}${e.vs_average}%`, label: 'vs average', tone: e.vs_average > 0 ? 'good' : 'bad' } : null,
    e.next_target ? { value: e.next_target.gap, label: `to ${ordinal(e.next_target.place)}` } : null,
    e.rank > 1 && e.best_display ? { value: e.best_display, label: 'Winning score' } : null,
  ].filter(Boolean);
  return (
    <section className="tr-panel tr-section" style={style}>
      <div className="tr-row">
        <span className="tr-event-icon"><Icon size={20} /></span>
        <div className="tr-grow">
          <b style={{ display: 'block', color: 'var(--ink)', fontSize: 16.5, fontWeight: 800, letterSpacing: '-.015em' }}>{e.name}</b>
          <div className="tr-verdict">{verdict(e)}</div>
        </div>
        <Medal rank={e.rank} />
      </div>
      <div className="tr-score-row">
        <div className="tr-grow">
          <div className="tr-score">{e.display}</div>
          <div className="tr-faint" style={{ marginTop: 4 }}>Beat {e.beat} of {Math.max(e.field - 1, 0)}</div>
        </div>
        <GradientRing value={e.percentile} a={a} b={b} size={74} stroke={10}>
          <b className="tr-num" style={{ fontSize: 15, fontWeight: 900, fontStyle: 'italic', color: 'var(--ink)' }}>{e.percentile}%</b>
        </GradientRing>
      </div>
      {stats.length > 0 && (
        <div className="tr-stats">
          {stats.map((s) => <div key={s.label} className="tr-stat" data-tone={s.tone}><b>{s.value}</b><span>{s.label}</span></div>)}
        </div>
      )}
      <Comparisons items={e.comparisons} />
      <Line lines={e.lines} savage={savage} />
      {nextTime(e) && <div className="tr-next"><Target size={16} />{nextTime(e)}</div>}
    </section>
  );
}

function MeTab({ report, savage, setSavage, onShare }) {
  const p = report.personal;
  const orderOf = (eventId) => Math.max(0, report.events.findIndex((x) => x.id === eventId));
  const won = p.rank && p.rank <= report.tournament.overall_positions;
  const colorOf = (i) => EVENT_COLORS[orderOf(p.events[i]?.event_id) % EVENT_COLORS.length];
  return (
    <>
      <section className="tr-panel tr-report">
        {won && <div className="tr-verdict">{p.rank === 1 ? 'Tournament champion' : 'Tournament winner'}</div>}
        <div className="tr-report-rank">
          <span className="tr-big-rank">{p.rank ? `#${p.rank}` : '–'}</span>
          <div className="tr-report-side">
            <b>{p.rank ? `${ordinal(p.rank)} of ${p.of}` : 'Not placed'}</b>
            <span className="tr-muted tr-num">{p.points} points</span>
          </div>
        </div>
        <div className="tr-me-medals">
          <span className="tr-me-medal"><Medal rank={1} />{p.gold}</span>
          <span className="tr-me-medal"><Medal rank={2} />{p.silver}</span>
          <span className="tr-me-medal"><Medal rank={3} />{p.bronze}</span>
        </div>
        <Line lines={p.lines} savage={savage} />
        <div className="tr-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div className="tr-toggle" role="group" aria-label="Tone">
            <button type="button" aria-pressed={!savage} onClick={() => setSavage(false)}><Smile size={15} />Friendly</button>
            <button type="button" aria-pressed={savage} onClick={() => setSavage(true)}><Skull size={15} />Savage</button>
          </div>
          <button type="button" className="tr-cta tr-cta-small" style={{ minHeight: 44 }} onClick={onShare}><Share2 size={15} />Share</button>
        </div>
      </section>

      {p.radar.length > 0 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title">Field beaten</div>
          <CompetitionRings items={p.radar} colorOf={colorOf} />
        </section>
      )}
      {p.radar.length >= 3 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title">Your shape</div>
          <Radar axes={p.radar} />
        </section>
      )}
      {(p.best_event || p.work_on) && (
        <div className="tr-stat-chips">
          {p.best_event && <span className="tr-stat-chip" data-tone="good"><TrendingUp size={14} />Strongest: {p.best_event.name}</span>}
          {p.work_on && <span className="tr-stat-chip" data-tone="hot"><Flame size={14} />Train next: {p.work_on.name}</span>}
        </div>
      )}
      {p.events.map((e) => <MyEvent key={e.event_id} e={e} index={orderOf(e.event_id)} savage={savage} />)}
    </>
  );
}

function OverallTab({ report }) {
  const { totals, overall, gym_war: war, tournament } = report;
  const placed = overall.filter((o) => o.points > 0);
  const [all, setAll] = useState(false);
  const rows = all ? overall : overall.slice(0, 10);
  const feats = report.events.map((e, i) => ({ e, i })).filter(({ e }) => e.summary.scored > 0 && e.summary.comparisons?.length);
  return (
    <>
      <div className="tr-kpis">
        <Kpi icon={Users} value={totals.athletes} label="Athletes" />
        <Kpi icon={Swords} value={`${totals.finished}/${totals.competitions}`} label="Events" />
        <Kpi icon={Layers} value={totals.scores} label="Scores" />
        <Kpi icon={Award} value={totals.gyms} label={totals.gyms === 1 ? 'Gym' : 'Gyms'} />
      </div>
      {placed.length > 0 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title"><Crown size={17} />Champions</div>
          <Podium rows={placed} labelOf={(r) => `${r.points} pts`} />
          {tournament.prize && <div className="tr-muted" style={{ textAlign: 'center' }}>Prize: {tournament.prize}</div>}
        </section>
      )}
      {war.length > 0 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title"><Swords size={17} />Gym war</div>
          <GymWar gyms={war} />
        </section>
      )}
      {overall.length > 0 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title"><Trophy size={17} />Medal table</div>
          <div className="tr-table-wrap">
            <table className="tr-table">
              <thead><tr><th>#</th><th>Athlete</th><th aria-label="Gold"><Medal rank={1} /></th><th aria-label="Silver"><Medal rank={2} /></th><th aria-label="Bronze"><Medal rank={3} /></th><th>Pts</th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} data-me={o.is_me || undefined}>
                    <td>{o.rank}</td><td>{o.name}</td><td>{o.gold}</td><td>{o.silver}</td><td>{o.bronze}</td><td><b>{o.points}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {overall.length > 10 && !all && <button type="button" className="btn" onClick={() => setAll(true)}>Show all {overall.length}</button>}
        </section>
      )}
      {feats.length > 0 && (
        <section className="tr-panel tr-section">
          <div className="tr-section-title"><Sparkles size={17} />What the room did</div>
          <div className="tr-compare">
            {feats.map(({ e, i }) => {
              const Icon = COMPARE_ICON[e.summary.comparisons[0].icon] || Sparkles;
              return (
                <div key={e.id} className="tr-compare-row" style={eventStyle(i)}>
                  <span className="tr-compare-icon"><Icon size={18} /></span>
                  <span className="tr-grow"><b style={{ display: 'block', fontWeight: 800 }}>{e.name}: {e.summary.total_display}</b><span className="tr-faint">{e.summary.comparisons[0].text}</span></span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}

function EventTab({ event, index }) {
  const [selected, setSelected] = useState(null);
  const s = event.summary;
  const lowerWins = event.metric === 'time_low';
  const Icon = eventIcon(event);
  return (
    <div className="tr-section" style={eventStyle(index)}>
      <div className="tr-row" style={{ justifyContent: 'space-between' }}>
        <div className="tr-row">
          <span className="tr-event-icon"><Icon size={20} /></span>
          <b style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.02em', color: 'var(--ink)' }}>{event.name}</b>
        </div>
        <PhaseChip phase={event.status === 'live' ? 'live' : event.status === 'completed' ? 'completed' : 'soon'} />
      </div>
      {s.scored === 0 ? (
        <div className="tr-panel tr-muted">No scores yet.</div>
      ) : (
        <>
          <section className="tr-panel"><Podium rows={event.rows} onPick={(r) => setSelected(r.id)} /></section>
          <div className="tr-kpis">
            <Kpi icon={Crown} value={s.best_display} label="Best" />
            <Kpi icon={Calculator} value={s.average_display} label="Average" />
            <Kpi icon={Gauge} value={s.median_display} label="Middle" />
          </div>
          {s.scored > 1 && (
            <section className="tr-panel tr-section">
              <div className="tr-section-title">The field</div>
              <DotStrip rows={event.rows} average={s.average} selected={selected} onSelect={(r) => setSelected(r.id)} />
            </section>
          )}
          <section className="tr-panel tr-section">
            <div className="tr-section-title">Leaderboard</div>
            <RankBars rows={event.rows} lowerWins={lowerWins} selected={selected} onSelect={(r) => setSelected(r.id)} />
          </section>
          {(s.comparisons?.length > 0 || s.pound_for_pound) && (
            <section className="tr-panel tr-section">
              <div className="tr-section-title">Between you all</div>
              <Comparisons items={s.comparisons} />
              {s.pound_for_pound && (
                <div className="tr-compare-row"><span className="tr-compare-icon"><Scale size={18} /></span>
                  Pound for pound: {s.pound_for_pound.name}, {s.pound_for_pound.ratio}× body weight</div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}

export default function ResultsView({ report, initialEvent, onShare }) {
  const hasMe = !!report.personal;
  const [tab, setTab] = useState(initialEvent || (hasMe ? 'me' : 'all'));
  const [savage, setSavage] = useState(false);
  const eventIndex = useMemo(() => report.events.findIndex((e) => e.id === tab), [report, tab]);
  const event = eventIndex >= 0 ? report.events[eventIndex] : null;
  const current = event ? tab : (tab === 'me' && !hasMe ? 'all' : tab);
  return (
    <>
      <div className="tr-tabs" role="tablist">
        {hasMe && <button type="button" role="tab" className="tr-tab" aria-selected={current === 'me'} onClick={() => setTab('me')}><UserRound size={15} />You</button>}
        <button type="button" role="tab" className="tr-tab" aria-selected={current === 'all'} onClick={() => setTab('all')}><Trophy size={15} />Tournament</button>
        {report.events.map((e) => {
          const Icon = eventIcon(e);
          return <button type="button" key={e.id} role="tab" className="tr-tab" aria-selected={current === e.id} onClick={() => setTab(e.id)}><Icon size={15} />{e.name}</button>;
        })}
      </div>
      {event ? <EventTab key={event.id} event={event} index={eventIndex} />
        : current === 'me' ? <MeTab report={report} savage={savage} setSavage={setSavage} onShare={onShare} />
          : <OverallTab report={report} />}
    </>
  );
}

/** What the share card says about one person's tournament. */
export function shareDetails(report, url) {
  const p = report.personal;
  const best = [...(p?.events || [])].filter((e) => e.rank != null).sort((a, b) => a.rank - b.rank)[0];
  return {
    tournament: report.tournament.name,
    theme: report.tournament.theme,
    name: p?.name || '',
    headline: p?.rank ? `#${p.rank}` : 'In',
    stat: best ? `${best.name}: ${best.display}` : '',
    detail: p ? `${p.gold} gold, ${p.silver} silver, ${p.bronze} bronze. ${p.points} points.` : '',
    url,
  };
}
