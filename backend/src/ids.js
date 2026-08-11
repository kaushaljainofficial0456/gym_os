// Dependency-free id generator (URL-safe, sortable-ish prefix).
const CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function id(prefix = 'id') {
  let s = '';
  const rnd = globalThis.crypto?.getRandomValues(new Uint8Array(10));
  for (let i = 0; i < 10; i++) {
    const r = rnd ? rnd[i] % CHARS.length : Math.floor(Math.random() * CHARS.length);
    s += CHARS[r];
  }
  return `${prefix}_${s}`;
}
export const now = () => new Date().toISOString();
export const dateKey = (d = new Date()) => d.toISOString().slice(0, 10);
