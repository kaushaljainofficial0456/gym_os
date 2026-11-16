/** Two letters for a gym with no logo: "Iron Forge" -> "IF", "Muscle" -> "MU".
 *  Its own file so a gym's mark never pulls in the colour maths. */
export function monogram(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'B';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
