// Pure TipTap-document helpers — the server derives contentText/wordCount from these
// (never trusting client-derived text) and the citation order for numeric styles.

export interface TipTapNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string }[];
  content?: TipTapNode[];
}

export const MAX_DOC_JSON_CHARS = 1_000_000;
export const EMPTY_DOC = { type: "doc", content: [] as unknown[] };

export function validateDoc(content: unknown): { ok: true } | { ok: false; reason: string } {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { ok: false, reason: "Content must be a document object" };
  }
  if ((content as TipTapNode).type !== "doc") {
    return { ok: false, reason: "Content must be a TipTap doc node" };
  }
  if (JSON.stringify(content).length > MAX_DOC_JSON_CHARS) {
    return { ok: false, reason: "Section content exceeds the 1 MB limit" };
  }
  return { ok: true };
}

function inlineText(node: TipTapNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  if (node.type === "citation") return "[citation]"; // plain-text fallback for search/word count
  return (node.content ?? []).map(inlineText).join("");
}

// Blocks joined with newlines, depth-first (lists/blockquotes flattened).
export function extractDocText(doc: unknown): string {
  const root = doc as TipTapNode;
  if (!root || root.type !== "doc") return "";
  const blocks: string[] = [];
  const walk = (node: TipTapNode) => {
    switch (node.type) {
      case "paragraph":
      case "heading":
      case "codeBlock": {
        const text = (node.content ?? []).map(inlineText).join("");
        if (text.trim()) blocks.push(text);
        break;
      }
      case "horizontalRule":
        break;
      default:
        (node.content ?? []).forEach(walk);
    }
  };
  (root.content ?? []).forEach(walk);
  return blocks.join("\n");
}

export function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

// First-use order of citation referenceIds across documents (document order, deduped
// keeping the first occurrence). `docs` must already be in section order.
export function collectCitationRefs(docs: unknown[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const walk = (node: TipTapNode) => {
    if (node.type === "citation") {
      const ids = node.attrs?.referenceIds;
      if (Array.isArray(ids)) {
        for (const id of ids) {
          if (typeof id === "string" && id && !seen.has(id)) {
            seen.add(id);
            ordered.push(id);
          }
        }
      }
    }
    (node.content ?? []).forEach(walk);
  };
  for (const doc of docs) {
    const root = doc as TipTapNode;
    if (root && root.type === "doc") (root.content ?? []).forEach(walk);
  }
  return ordered;
}
