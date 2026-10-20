import { api } from '../../../api.js';
import { fromAIEstimate } from './plate.js';

/**
 * Ask the AI for one dish the food database could not match, as a plate
 * item. Only ever called from an explicit tap ("Estimate with AI"): it can
 * cost money and takes seconds, so it is never fired on its own.
 *
 * Throws with a message fit for the screen when no estimate came back --
 * not configured on this server, every provider failed, or the answer did
 * not pass the server's plausibility checks.
 */
export async function aiEstimateItem(query) {
  const q = String(query || '').trim();
  if (!q) throw new Error('Say what the dish is first.');
  let res;
  try {
    res = await api('/me/foods/ai-estimate', { method: 'POST', body: JSON.stringify({ query: q.slice(0, 150) }) });
  } catch (e) {
    throw new Error(/not configured/i.test(e.message || '')
      ? 'AI estimates are not switched on for this gym yet.'
      : 'AI could not estimate that right now. Try again, or search for it.');
  }
  if (!res?.ok) throw new Error('AI could not estimate that. Try describing it differently.');
  return fromAIEstimate(res);
}
