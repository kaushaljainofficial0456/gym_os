/** /t/:code and /t/:code/screen, behind one lazy import for the entry bundle's sake. */
import { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { lazyWithReload as lazy } from '../../lazyWithReload.js';
import { Spinner } from '../../components/UI.jsx';

const TournamentPublic = lazy(() => import('./TournamentPublic.jsx'));
const TournamentScreen = lazy(() => import('./TournamentScreen.jsx'));

export default function TournamentPublicArea() {
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route index element={<TournamentPublic />} />
        <Route path="screen" element={<TournamentScreen />} />
      </Routes>
    </Suspense>
  );
}
