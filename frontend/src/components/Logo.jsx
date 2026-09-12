import { useTheme } from '../themeContext.jsx';

/**
 * Theme-aware app logo. Every screen that shows the wordmark renders THIS,
 * never a bare <img src="/logo-...png">, so the two colour variants
 * (red for light, blue-grey for dark -- each supplied pre-matched to its
 * theme, not derived here) can never drift out of sync with the active
 * theme or with each other. `useTheme()` is the same hook the rest of the
 * app already reads/toggles theme through (see themeContext.jsx), so this
 * responds live to a theme switch exactly like every other themed surface
 * on the page -- no separate logic, no flash of the wrong colour.
 */
export default function Logo({ className, alt = 'Barbell', ...rest }) {
  // `resolved` (never the raw choice): 'system' is now a storable
  // value, and every comparison below is against light/dark.
  const { resolved: theme } = useTheme();
  const src = theme === 'dark' ? '/logo-dark.png' : '/logo-light.png';
  return <img src={src} alt={alt} className={className} {...rest} />;
}
