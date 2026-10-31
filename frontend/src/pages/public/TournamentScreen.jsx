/**
 * THE GYM TV — /t/:code/screen
 *
 * Open it on the screen above the floor and leave it. It follows whatever is
 * live, cycles through the competitions, and keeps the QR up so anyone
 * watching can enter or follow on their phone.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../../api.js';
import { Spinner } from '../../components/UI.jsx';
import { joinUrl, themeClass } from '../tournaments/shared.jsx';
import { Medal } from '../tournaments/visuals.jsx';

export default function TournamentScreen() {
  const { code } = useParams();
  const [page, setPage] = useState(null);
  const [gone, setGone] = useState(false);
  const [turn, setTurn] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => api(`/tournaments-public/${encodeURIComponent(code)}`)
      .then((p) => { if (alive) setPage(p); })
      .catch((e) => { if (alive && e.status === 404) setGone(true); });
    load();
    const poll = setInterval(load, 5000);
    const cycle = setInterval(() => setTurn((n) => n + 1), 9000);
    return () => { alive = false; clearInterval(poll); clearInterval(cycle); };
  }, [code]);

  if (gone) return <div className="tr-public">This tournament is not available.</div>;
  if (!page) return <div className="tr-public"><Spinner /></div>;

  const report = page.results;
  const live = report.events.filter((e) => e.status === 'live');
  const scored = report.events.filter((e) => e.summary.scored > 0);
  const pool = live.length ? live : scored.length ? scored : report.events;
  const event = pool[turn % pool.length];
  const rows = (event?.rows || []).slice(0, 8);
  const overall = report.overall.filter((o) => o.points > 0).slice(0, 5);

  return (
    <div className={`tr-sheet tr-screen ${themeClass(page.theme)}`}>
      <h1>{page.name}</h1>
      <div className="tr-screen-grid">
        <section className="tr-screen-panel">
          <h2>{event?.name}{event?.status === 'live' ? ' · Live' : ''}</h2>
          {rows.length === 0 && <div className="tr-screen-row"><span /><span>Waiting for the first score</span></div>}
          {rows.map((r) => (
            <div key={r.id} className="tr-screen-row">
              <Medal rank={r.rank} /><span>{r.name}</span><b>{r.display}</b>
            </div>
          ))}
        </section>
        <section className="tr-screen-panel" style={{ justifyContent: 'space-between' }}>
          <div>
            <h2>Overall</h2>
            {overall.map((o) => (
              <div key={o.id} className="tr-screen-row"><Medal rank={o.rank} /><span>{o.name}</span><b>{o.points}</b></div>
            ))}
          </div>
          <div className="tr-screen-qr">
            <QRCodeSVG value={joinUrl(code)} size={150} level="M" marginSize={1} />
            Scan to follow · {code}
          </div>
        </section>
      </div>
    </div>
  );
}
