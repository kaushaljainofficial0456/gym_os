/**
 * The signed-out routes' shared frame. One AuthShell for all of them, so
 * the stage -- the mark and its draw-in -- carries on from Welcome to Sign
 * in to Set up instead of being torn down and redrawn at every step. Each screen tells the stage how tall to be and what line
 * to show through useAuthStage.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import AuthShell from './AuthShell.jsx';

const StageContext = createContext(null);

export const DEFAULT_HEADLINE = [
  { text: 'Train smarter.' },
  { text: 'Coach better.' },
  { text: 'Prove progress.', accent: true },
];

/**
 * Set the stage for the current screen: how tall, which line, and which
 * audience's product cards float on it ('welcome' | 'member' | 'owner' |
 * 'coach'). `headline` must be a stable value (a module-level constant),
 * or every render would re-announce it. Outside AuthLayout this does
 * nothing.
 */
export function useAuthStage(variant, headline = DEFAULT_HEADLINE, showcase = 'welcome') {
  const set = useContext(StageContext);
  useEffect(() => { set?.({ variant, headline, showcase }); }, [set, variant, headline, showcase]);
}

export default function AuthLayout() {
  const [stage, setStage] = useState({ variant: 'hero', headline: DEFAULT_HEADLINE, showcase: 'welcome' });
  const { pathname } = useLocation();
  return (
    <StageContext.Provider value={setStage}>
      <AuthShell variant={stage.variant} headline={stage.headline} showcase={stage.showcase}>
        <div key={pathname} className="auth-view">
          <Outlet />
        </div>
      </AuthShell>
    </StageContext.Provider>
  );
}
