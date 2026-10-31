/**
 * The signed-in tournament screens, behind one lazy import. Listing them in
 * App.jsx would add every screen's file list to the entry bundle that all
 * visitors download, including the ones who never open this feature.
 */
import { Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import { lazyWithReload as lazy } from '../../lazyWithReload.js';
import { PageSkeleton } from '../../components/UI.jsx';

const Hub = lazy(() => import('./Hub.jsx'));
const Create = lazy(() => import('./Create.jsx'));
const Detail = lazy(() => import('./Detail.jsx'));
const Scorer = lazy(() => import('./Scorer.jsx'));
const Results = lazy(() => import('./Results.jsx'));

export default function TournamentArea() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Routes>
        <Route index element={<Hub />} />
        <Route path="new" element={<Create />} />
        <Route path=":id" element={<Detail />} />
        <Route path=":id/live/:eventId" element={<Scorer />} />
        <Route path=":id/results" element={<Results />} />
      </Routes>
    </Suspense>
  );
}
