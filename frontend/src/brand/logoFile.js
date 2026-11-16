/**
 * A logo file from the owner's phone or computer -> a small square PNG
 * data URL, ready to store. Resized in the browser (a camera photo of a
 * signboard can be 5 MB; the server takes 300 kB at most) and squared: a
 * roughly square logo fills the square, a wide wordmark is fitted inside
 * it on a transparent ground so none of it is cut off.
 */
const SIZE = 256;
const MAX_BYTES = 280 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be opened as an image')); };
    img.src = url;
  });
}

export async function logoFromFile(file) {
  if (!file) throw new Error('No file chosen');
  if (!TYPES.includes(file.type)) throw new Error('Choose a PNG, JPG or WebP image');
  if (file.size > 15 * 1024 * 1024) throw new Error('That image is too large (15 MB at most)');
  const img = await loadImage(file);
  const w = img.naturalWidth; const h = img.naturalHeight;
  if (!w || !h) throw new Error('That file could not be opened as an image');
  const canvas = document.createElement('canvas');
  canvas.width = SIZE; canvas.height = SIZE;
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const ratio = w / h;
  if (ratio > 0.85 && ratio < 1.18) {
    const s = Math.min(w, h);                       // nearly square: fill
    g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SIZE, SIZE);
  } else {
    const pad = SIZE * 0.08;                        // wide or tall: fit inside
    const k = Math.min((SIZE - pad * 2) / w, (SIZE - pad * 2) / h);
    const dw = w * k; const dh = h * k;
    g.drawImage(img, (SIZE - dw) / 2, (SIZE - dh) / 2, dw, dh);
  }
  let out = canvas.toDataURL('image/png');
  if (out.length * 0.75 > MAX_BYTES) out = canvas.toDataURL('image/webp', 0.9);
  if (out.length * 0.75 > MAX_BYTES) out = canvas.toDataURL('image/jpeg', 0.86);
  return out;
}
