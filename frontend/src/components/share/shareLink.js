/** Hand a link to the phone's own share sheet (WhatsApp, Messages...),
 *  or copy it where there is none. Says which happened. */
export async function shareLink(url, title, text) {
  if (navigator.share) {
    try { await navigator.share({ title, text, url }); return 'shared'; } catch { /* cancelled */ }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'shown'; }
}
