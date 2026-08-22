/**
 * DockNavItem — react bits' Dock magnify-on-proximity spring physics,
 * adapted onto ClientLayout's existing full-width bottom tab (not the
 * demo's floating centered pill -- this is a mobile app's persistent tab
 * bar, and the label stays always-visible rather than a hover tooltip,
 * since that's how every bottom nav on a touch device has to work: there
 * is no hover state to reveal it with on a phone).
 *
 * The magnify effect itself only ever engages under a real mouse (the
 * parent computes mouseX from pointer position, which simply never
 * updates on a touchscreen), so touch users get exactly today's nav with
 * zero regression, and desktop/trackpad users get the extra delight.
 */
import { useRef } from 'react';
import { motion, useTransform, useSpring } from 'framer-motion';
import { NavLink } from 'react-router-dom';

export default function DockNavItem({ to, end, label, icon, mouseX, baseSize = 20, magnifySize = 28, distance = 90, spring }) {
  const ref = useRef(null);

  const dist = useTransform(mouseX, val => {
    const rect = ref.current?.getBoundingClientRect() ?? { x: 0, width: baseSize };
    return val - rect.x - rect.width / 2;
  });
  const targetSize = useTransform(dist, [-distance, 0, distance], [baseSize, magnifySize, baseSize]);
  const size = useSpring(targetSize, spring);

  return (
    <NavLink ref={ref} to={to} end={end}
      className={({ isActive }) => `flex flex-col items-center justify-end gap-1 py-2.5 rounded-xl font-grotesk text-[9px] font-bold uppercase tracking-[.14em] transition-colors duration-200 ${isActive ? 'text-accent' : ''}`}
      style={({ isActive }) => ({ color: isActive ? undefined : 'var(--mute)', background: isActive ? 'rgb(var(--accent-rgb) / .08)' : 'transparent' })}>
      <motion.span style={{ width: size, height: size }} className="grid place-items-center">{icon}</motion.span>
      {label}
    </NavLink>
  );
}
