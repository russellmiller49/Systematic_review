type PooledIdentityRow = {
  id: string;
  projectId: string;
  doi: string | null;
  pmid: string | null;
  normalizedTitle: string;
  createdAt: Date;
};

// Exact DOI, PMID, or normalized-title matches form one connected component. The connected
// component matters: one import may have the DOI but another may only carry the matching title.
// This mirrors the app's exact deduplication signals without applying fuzzy matching across
// tenant-separated PICO projects.
export function groupPooledCitationRows<T extends PooledIdentityRow>(rows: readonly T[]): T[][] {
  const parent = rows.map((_, index) => index);
  const rank = rows.map(() => 0);

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root]!;
    while (parent[index] !== index) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;
    if (rank[rootA]! < rank[rootB]!) [rootA, rootB] = [rootB, rootA];
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA]! += 1;
  };

  const firstByIdentity = new Map<string, number>();
  rows.forEach((row, index) => {
    const identities = [
      row.doi?.trim().toLowerCase() ? `doi:${row.doi.trim().toLowerCase()}` : null,
      row.pmid?.trim() ? `pmid:${row.pmid.trim()}` : null,
      row.normalizedTitle.trim()
        ? `title:${row.normalizedTitle.trim().toLowerCase()}`
        : null,
    ].filter((identity): identity is string => identity !== null);
    for (const identity of identities) {
      const first = firstByIdentity.get(identity);
      if (first === undefined) firstByIdentity.set(identity, index);
      else union(first, index);
    }
  });

  const grouped = new Map<number, T[]>();
  rows.forEach((row, index) => {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(row);
    grouped.set(root, group);
  });
  return [...grouped.values()].sort((a, b) => {
    const aTime = Math.min(...a.map((row) => row.createdAt.getTime()));
    const bTime = Math.min(...b.map((row) => row.createdAt.getTime()));
    if (aTime !== bTime) return aTime - bTime;
    return a[0]!.id.localeCompare(b[0]!.id);
  });
}
