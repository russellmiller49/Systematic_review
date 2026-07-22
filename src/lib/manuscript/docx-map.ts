// TipTap JSON → neutral DOCX intermediate representation. Pure and fully unit-testable
// without the `docx` package; src/server/services/manuscript/docx.ts turns the IR into a
// real Document. The editor only enables the node types handled here, so the mapping is
// exhaustive for well-formed content; unknown nodes degrade to plain paragraphs.

import type { TipTapNode } from "./doc-text";

export interface DocxRun {
  text: string;
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  break?: boolean; // hard line break BEFORE this run's text
}

export type DocxBlockKind =
  | "paragraph"
  | "heading2"
  | "heading3"
  | "bullet"
  | "numbered"
  | "blockquote"
  | "code"
  | "hr";

export interface DocxBlock {
  kind: DocxBlockKind;
  runs: DocxRun[];
  level?: number; // list nesting depth (0-based)
  numberingGroup?: number; // one group per orderedList INSTANCE so numbering restarts
}

function markSet(node: TipTapNode): Omit<DocxRun, "text" | "break"> {
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);
  return {
    ...(has("bold") ? { bold: true } : {}),
    ...(has("italic") ? { italics: true } : {}),
    ...(has("underline") ? { underline: true } : {}),
    ...(has("strike") ? { strike: true } : {}),
    ...(has("code") ? { code: true } : {}),
  };
}

function inlineRuns(
  nodes: TipTapNode[],
  resolveCitation: (referenceIds: string[]) => string,
): DocxRun[] {
  const runs: DocxRun[] = [];
  let pendingBreak = false;
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      pendingBreak = true;
      continue;
    }
    let text: string | null = null;
    let marks: Omit<DocxRun, "text" | "break"> = {};
    if (node.type === "text") {
      text = node.text ?? "";
      marks = markSet(node);
    } else if (node.type === "citation") {
      const ids = Array.isArray(node.attrs?.referenceIds)
        ? (node.attrs!.referenceIds as unknown[]).filter((id): id is string => typeof id === "string")
        : [];
      text = resolveCitation(ids);
    } else if (node.content) {
      runs.push(...inlineRuns(node.content, resolveCitation));
      continue;
    }
    if (text !== null && (text.length > 0 || pendingBreak)) {
      runs.push({ text, ...marks, ...(pendingBreak ? { break: true } : {}) });
      pendingBreak = false;
    }
  }
  return runs;
}

export function docToBlocks(
  doc: unknown,
  resolveCitation: (referenceIds: string[]) => string,
): DocxBlock[] {
  const root = doc as TipTapNode;
  if (!root || root.type !== "doc") return [];
  const blocks: DocxBlock[] = [];
  let numberingCounter = 0;

  const walkList = (node: TipTapNode, ordered: boolean, level: number, group: number) => {
    for (const item of node.content ?? []) {
      if (item.type !== "listItem") continue;
      for (const child of item.content ?? []) {
        if (child.type === "paragraph") {
          blocks.push({
            kind: ordered ? "numbered" : "bullet",
            runs: inlineRuns(child.content ?? [], resolveCitation),
            level,
            ...(ordered ? { numberingGroup: group } : {}),
          });
        } else if (child.type === "bulletList") {
          walkList(child, false, level + 1, group);
        } else if (child.type === "orderedList") {
          numberingCounter += 1;
          walkList(child, true, level + 1, numberingCounter);
        }
      }
    }
  };

  const walkBlock = (node: TipTapNode) => {
    switch (node.type) {
      case "paragraph":
        blocks.push({ kind: "paragraph", runs: inlineRuns(node.content ?? [], resolveCitation) });
        break;
      case "heading": {
        const level = typeof node.attrs?.level === "number" ? node.attrs.level : 2;
        blocks.push({
          kind: level <= 2 ? "heading2" : "heading3",
          runs: inlineRuns(node.content ?? [], resolveCitation),
        });
        break;
      }
      case "bulletList":
        walkList(node, false, 0, 0);
        break;
      case "orderedList":
        numberingCounter += 1;
        walkList(node, true, 0, numberingCounter);
        break;
      case "blockquote":
        for (const child of node.content ?? []) {
          blocks.push({
            kind: "blockquote",
            runs: inlineRuns(child.content ?? [], resolveCitation),
          });
        }
        break;
      case "codeBlock":
        blocks.push({ kind: "code", runs: inlineRuns(node.content ?? [], resolveCitation) });
        break;
      case "horizontalRule":
        blocks.push({ kind: "hr", runs: [] });
        break;
      default: {
        // Defensive: unknown node → its concatenated text as a plain paragraph.
        const runs = inlineRuns(node.content ?? [], resolveCitation);
        if (runs.length > 0) blocks.push({ kind: "paragraph", runs });
      }
    }
  };

  (root.content ?? []).forEach(walkBlock);
  return blocks;
}

// Numbering groups are unique only WITHIN one docToBlocks call. When several sections
// (or several projects' manuscripts) are assembled into one document, equal group ids
// would share a Word numbering instance and numbering would continue across lists.
// Shifts each call's groups so they are globally disjoint; input arrays are not mutated.
export function offsetNumberingGroups(sections: DocxBlock[][]): DocxBlock[][] {
  let offset = 0;
  return sections.map((blocks) => {
    let maxGroup = 0;
    const shifted = blocks.map((block) => {
      if (block.numberingGroup === undefined) return block;
      maxGroup = Math.max(maxGroup, block.numberingGroup);
      return { ...block, numberingGroup: block.numberingGroup + offset };
    });
    offset += maxGroup;
    return shifted;
  });
}
