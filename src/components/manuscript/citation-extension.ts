import { mergeAttributes, Node } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { CitationChip } from "./citation-chip";

export interface CitationAttrs {
  referenceIds: string[];
}

// Inline ATOM node holding reference-library ids. Rendering is a NodeView chip; the
// stored document only ever contains the ids (markers are derived, never persisted).
export const CitationNode = Node.create({
  name: "citation",
  group: "inline",
  inline: true,
  atom: true,

  addAttributes() {
    return {
      referenceIds: {
        default: [] as string[],
        parseHTML: (element) => {
          try {
            return JSON.parse(element.getAttribute("data-reference-ids") ?? "[]") as string[];
          } catch {
            return [];
          }
        },
        renderHTML: (attributes) => ({
          "data-reference-ids": JSON.stringify(attributes.referenceIds ?? []),
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-citation]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes({ "data-citation": "" }, HTMLAttributes), "[citation]"];
  },

  renderText() {
    return "[citation]";
  },

  addNodeView() {
    return ReactNodeViewRenderer(CitationChip);
  },
});
