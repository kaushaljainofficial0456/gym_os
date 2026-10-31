// A result worth posting is how the next gym hears about this. Draws a
// portrait card on a canvas and hands it to the phone's share sheet, or
// downloads it where sharing a file is not supported.
const HUES = { ember: '#FF7A4D', neon: '#FF5FA8', ocean: '#4FB3FF', volt: '#3FD9A4', royal: '#B497FF' };
const BLACK = '#0A0909';
const INK = '#FFF3F1';

/** The app's look: a black floor with the tournament's light on it. */
function floodlight(c, w, h, hue) {
  c.fillStyle = BLACK;
  c.fillRect(0, 0, w, h);
  const glow = c.createRadialGradient(w * 0.82, 0, 0, w * 0.82, 0, w * 1.05);
  glow.addColorStop(0, `${hue}66`);
  glow.addColorStop(1, `${hue}00`);
  c.fillStyle = glow;
  c.fillRect(0, 0, w, h);
}

function wrap(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function drawCard({ tournament, theme, name, headline, stat, detail, url }) {
  const W = 1080; const H = 1350; const M = 90;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  const hue = HUES[theme] || '#D9A441';
  floodlight(c, W, H, hue);

  const font = (weight, size) => `${weight} ${size}px "DM Sans", system-ui, sans-serif`;
  c.textBaseline = 'alphabetic';
  c.fillStyle = 'rgba(255,243,241,.8)';
  c.font = font(700, 42);
  let y = 150;
  for (const line of wrap(c, tournament, W - M * 2).slice(0, 2)) { c.fillText(line, M, y); y += 54; }

  c.fillStyle = hue;
  c.font = font(800, 300);
  c.fillText(headline, M - 8, 620);

  c.fillStyle = INK;
  c.font = font(800, 76);
  y = 760;
  for (const line of wrap(c, name, W - M * 2).slice(0, 2)) { c.fillText(line, M, y); y += 88; }

  if (stat) {
    c.fillStyle = INK;
    c.font = font(800, 56);
    c.fillText(stat, M, y + 16);
    y += 90;
  }
  if (detail) {
    c.fillStyle = 'rgba(255,243,241,.74)';
    c.font = font(600, 40);
    for (const line of wrap(c, detail, W - M * 2).slice(0, 3)) { c.fillText(line, M, y + 12); y += 52; }
  }

  c.fillStyle = INK;
  c.font = font(800, 46);
  c.fillText('Barbell', M, H - 130);
  c.fillStyle = 'rgba(255,243,241,.74)';
  c.font = font(600, 34);
  c.fillText(url.replace(/^https?:\/\//, ''), M, H - 80);
  return canvas;
}

/** A printable A-series poster for the wall by the door. `qr` is the QR canvas on screen. */
export function downloadPoster({ tournament, title, sub, code, url, theme, qr }) {
  const W = 1240; const H = 1754;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext('2d');
  c.fillStyle = '#fff'; c.fillRect(0, 0, W, H);
  c.save();
  c.beginPath(); c.rect(0, 0, W, 620); c.clip();
  floodlight(c, W, 620, HUES[theme] || '#D9A441');
  c.restore();

  const font = (weight, size) => `${weight} ${size}px "DM Sans", system-ui, sans-serif`;
  c.textAlign = 'center';
  c.fillStyle = INK;
  c.font = font(800, title.length > 18 ? 84 : 112);
  let y = 250;
  for (const line of wrap(c, title, W - 160).slice(0, 2)) { c.fillText(line, W / 2, y); y += 120; }
  c.fillStyle = 'rgba(255,243,241,.78)';
  c.font = font(700, 48);
  c.fillText(sub, W / 2, y + 10);

  c.imageSmoothingEnabled = false;
  c.drawImage(qr, (W - 820) / 2, 680, 820, 820);

  c.fillStyle = '#17121a';
  c.font = font(800, 68);
  c.fillText('Scan to enter', W / 2, 1580);
  c.fillStyle = '#5B5560';
  c.font = font(600, 40);
  c.fillText(`${url.replace(/^https?:\/\//, '')}`, W / 2, 1642);
  c.font = font(600, 34);
  c.fillText(`Code ${code} · ${tournament}`.slice(0, 70), W / 2, 1696);

  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${code}-poster.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  }, 'image/png');
}

/** Returns 'shared', 'saved', or 'cancelled'. */
export async function shareResultCard(details) {
  if (document.fonts?.ready) await document.fonts.ready;
  const canvas = drawCard(details);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const file = new File([blob], 'barbell-result.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: details.tournament, text: details.url });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
  return 'saved';
}
