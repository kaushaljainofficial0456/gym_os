/**
 * The gym's mark: its uploaded logo, or -- with none, or if the image
 * fails to load -- its initials on its own main colour. The initials take
 * their colours from the theme tokens (the filled-button colour and its
 * label colour), so they are always readable and always on-brand,
 * including inside the branding studio's preview.
 *
 * `size` in px; null leaves width, height and type size to the caller's
 * CSS (the sign-in stage, where the mark's size is itself a variable).
 */
import { useState } from 'react';
import { monogram } from './monogram.js';
import './brand.css';

export default function GymMark({ brand, size = 32, radius, className = '' }) {
  const [failed, setFailed] = useState(null);
  const style = size == null ? undefined : { width: size, height: size, borderRadius: radius ?? Math.round(size * 0.28) };
  const logo = brand?.logoUrl && failed !== brand.logoUrl ? brand.logoUrl : null;
  if (logo) {
    return (
      <img src={logo} alt="" aria-hidden="true" className={`gym-mark gym-mark--logo ${className}`} style={style}
        onError={() => setFailed(logo)} decoding="async" />
    );
  }
  return (
    <span aria-hidden="true" className={`gym-mark ${className}`}
      style={size == null ? undefined : { ...style, fontSize: Math.max(10, Math.round(size * 0.38)) }}>
      {monogram(brand?.gymName)}
    </span>
  );
}
