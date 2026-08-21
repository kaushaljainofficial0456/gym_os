/**
 * className helper — clsx for conditionals, tailwind-merge for conflicts.
 *
 * WHY NOT THE EXISTING `cls()` IN src/utils.js:
 * `cls()` joins truthy strings, which is fine until a component takes a
 * `className` prop meant to OVERRIDE a default. `cls('p-5', 'p-2')` emits
 * "p-5 p-2" and the winner is whichever Tailwind emitted last in the
 * stylesheet -- not the caller's. That makes overriding a primitive's
 * padding silently unreliable, which is exactly the bug a design system
 * exists to prevent.
 *
 * `cn()` resolves that: twMerge knows `p-5` and `p-2` are the same
 * property and keeps the LAST one, so caller intent always wins.
 *
 * `cls()` is left in place and still used by existing components -- this
 * does not replace it, it is the one to reach for in new primitives.
 */
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
