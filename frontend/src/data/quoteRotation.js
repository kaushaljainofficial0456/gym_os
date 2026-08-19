// Quote rotation: avoids recently shown quotes using localStorage history.
// A pool of quotes is shuffled; once exhausted, the full pool reshuffles.
// Recent history is kept to prevent immediate repetition.

import QUOTES from '../data/quotes.js';

const STORAGE_KEY = 'sk_quote_history';
const HISTORY_SIZE = 10; // remember last N quotes

function getHistory() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveHistory(history) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    // localStorage might be full or unavailable — fail silently
  }
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Returns the next motivational quote.
 * Uses local history to avoid recent repetition.
 * After the pool is exhausted, it reshuffles all quotes.
 */
export function getNextQuote() {
  const history = getHistory();

  // Build the available pool (exclude recently shown)
  const available = QUOTES.filter((q) => !history.includes(q));

  let pool;
  if (available.length === 0) {
    // All quotes have been shown — shuffle full pool, clear history
    pool = shuffle(QUOTES);
    saveHistory([]);
  } else {
    pool = shuffle(available);
  }

  const quote = pool[0];

  // Update history: prepend new quote, trim to HISTORY_SIZE
  const newHistory = [quote, ...history].slice(0, HISTORY_SIZE);
  saveHistory(newHistory);

  return quote;
}
