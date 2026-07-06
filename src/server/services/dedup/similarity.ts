// Jaro-Winkler string similarity — pure functions, no I/O. Used by the dedup engine for
// fuzzy title matching (on already-normalized titles). Unit-tested in similarity.test.ts
// against the classic published values (e.g. MARTHA/MARHTA ≈ 0.9611).

// Jaro similarity in [0, 1]: proportion of matching characters (within the standard
// half-length window) adjusted for transpositions.
export function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  const window = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatched = new Array<boolean>(la).fill(false);
  const bMatched = new Array<boolean>(lb).fill(false);

  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - window);
    const end = Math.min(i + window + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  return (matches / la + matches / lb + (matches - t) / matches) / 3;
}

const WINKLER_PREFIX_SCALE = 0.1;
const WINKLER_MAX_PREFIX = 4;

// Jaro-Winkler: Jaro boosted by a shared prefix (up to 4 chars, scale 0.1).
export function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  const limit = Math.min(WINKLER_MAX_PREFIX, a.length, b.length);
  let prefix = 0;
  while (prefix < limit && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * WINKLER_PREFIX_SCALE * (1 - jaro);
}
