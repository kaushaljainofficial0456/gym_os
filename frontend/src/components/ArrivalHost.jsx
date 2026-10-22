/**
 * Plays the arrival moment (MotivationalWelcome) over whatever screen the
 * app navigates to next.
 *
 * It used to be rendered by the sign-in page itself -- which the router
 * replaces the instant the session exists (GuestOnly in App.jsx), so the
 * moment unmounted before it could be seen, and the navigation it was
 * holding back never ran. Announcing it here instead means navigation
 * happens straight away and the dashboard loads underneath while the
 * greeting plays on top.
 *
 * Skipped for automated browsers, like the intro.
 */
import { useEffect, useState } from 'react';
import MotivationalWelcome from './MotivationalWelcome.jsx';

const EVENT = 'barbell:arrival';

export function announceArrival(name) {
  if (typeof window === 'undefined' || window.navigator.webdriver) return;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { name: name || '' } }));
}

export default function ArrivalHost() {
  const [name, setName] = useState(null);
  useEffect(() => {
    const on = (e) => setName(e.detail?.name ?? '');
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  if (name === null) return null;
  return <MotivationalWelcome name={name} onComplete={() => setName(null)} />;
}
