// One graph implementation for normalization, merge guards, and bulk eligibility.
export function connectedComponents<T extends { citationAId: string; citationBId: string }>(
  edges: T[],
): T[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    while (parent.has(id) && parent.get(id) !== root) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  for (const edge of edges) parent.set(find(edge.citationAId), find(edge.citationBId));
  const components = new Map<string, T[]>();
  for (const edge of edges) {
    const root = find(edge.citationAId);
    const component = components.get(root) ?? [];
    component.push(edge);
    components.set(root, component);
  }
  return [...components.values()];
}
