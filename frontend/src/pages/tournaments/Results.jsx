/** The summary inside the app. Hosts and everyone who can see it land here. */
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { RotateCcw } from './icons.jsx';
import { api } from '../../api.js';
import { useFetch } from '../../utils.js';
import { ErrorState, PageSkeleton, Toast } from '../../components/UI.jsx';
import { Hero, PhaseChip, joinUrl, themeClass, useTournamentBase } from './shared.jsx';
import { Confetti } from './visuals.jsx';
import ResultsView, { shareDetails } from './ResultsView.jsx';
import { shareResultCard } from './shareCard.js';

export default function Results() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const base = useTournamentBase();
  const report = useFetch(() => api(`/tournaments/${id}/results`), [id]);
  const detail = useFetch(() => api(`/tournaments/${id}`), [id]);
  const [toast, setToast] = useState('');

  const live = report.data?.tournament.status === 'live';
  const { reload } = report;
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(() => { if (!document.hidden) reload({ silent: true }); }, 8000);
    return () => clearInterval(timer);
  }, [live, reload]);

  if (report.loading && !report.data) return <PageSkeleton />;
  if (report.error && !report.data) return <ErrorState error={report.error} onRetry={report.reload} />;

  const r = report.data;
  const code = detail.data?.code;
  const share = async () => {
    const outcome = await shareResultCard(shareDetails(r, code ? joinUrl(code) : window.location.origin));
    if (outcome === 'saved') setToast('Card saved. Post it anywhere');
  };
  const celebrate = r.tournament.status === 'completed' && !!r.personal?.rank && r.personal.rank <= r.tournament.overall_positions;

  return (
    <div className={`tr-root ${themeClass(r.tournament.theme)}`}>
      <Confetti run={celebrate} />
      <Hero back={{ label: 'Back to the tournament', onClick: () => nav(`${base}/${id}`) }}
        actions={detail.data?.you?.is_prime && r.tournament.status === 'completed' && (
          <button type="button" className="tr-hero-back" aria-label="Run a rematch" onClick={() => nav(`${base}/new?from=${id}`)}><RotateCcw size={17} /></button>
        )}
        eyebrow={<PhaseChip phase={r.tournament.status === 'live' ? 'live' : 'completed'} onHero />}
        title={r.tournament.name}
        tagline={celebrate ? (r.personal.rank === 1 ? 'Champion.' : 'On the podium.') : null} />
      <ResultsView report={r} initialEvent={params.get('event')} onShare={share} />
      <Toast message={toast} onDone={() => setToast('')} />
    </div>
  );
}
