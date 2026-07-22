// DOCX assembly: sections (via the pure docx-map IR) + formatted references appended.
// Kept separate from index.ts so the `docx` dependency stays out of the hot service path.

import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from "docx";
import type { DocxBlock, DocxRun } from "@/lib/manuscript/docx-map";

export interface DocxSectionInput {
  title: string;
  kind: string; // TITLE_PAGE prints no heading
  blocks: DocxBlock[];
}

export interface DocxBibliographyEntry {
  index: number;
  text: string;
}

const BULLET_REF = "manuscript-bullets";

function runsToDocx(runs: DocxRun[]): TextRun[] {
  return runs.map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italics,
        underline: run.underline ? {} : undefined,
        strike: run.strike,
        font: run.code ? "Courier New" : undefined,
        break: run.break ? 1 : undefined,
      }),
  );
}

export async function buildManuscriptDocx(input: {
  projectTitle: string;
  manuscriptTitle: string;
  sections: DocxSectionInput[];
  bibliography: DocxBibliographyEntry[];
  numericStyle: boolean;
}): Promise<Uint8Array> {
  const children: Paragraph[] = [];
  const numberingConfigs = new Set<number>();

  children.push(
    new Paragraph({
      text: input.manuscriptTitle,
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
    }),
  );

  for (const section of input.sections) {
    if (section.kind !== "TITLE_PAGE") {
      children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1 }));
    }
    for (const block of section.blocks) {
      switch (block.kind) {
        case "heading2":
          children.push(new Paragraph({ children: runsToDocx(block.runs), heading: HeadingLevel.HEADING_2 }));
          break;
        case "heading3":
          children.push(new Paragraph({ children: runsToDocx(block.runs), heading: HeadingLevel.HEADING_3 }));
          break;
        case "bullet":
          children.push(
            new Paragraph({
              children: runsToDocx(block.runs),
              numbering: { reference: BULLET_REF, level: Math.min(block.level ?? 0, 3) },
            }),
          );
          break;
        case "numbered": {
          const group = block.numberingGroup ?? 0;
          numberingConfigs.add(group);
          children.push(
            new Paragraph({
              children: runsToDocx(block.runs),
              numbering: { reference: `manuscript-ol-${group}`, level: Math.min(block.level ?? 0, 3) },
            }),
          );
          break;
        }
        case "blockquote":
          children.push(
            new Paragraph({
              children: runsToDocx(block.runs.map((r) => ({ ...r, italics: true }))),
              indent: { left: 720 },
            }),
          );
          break;
        case "code":
          children.push(
            new Paragraph({
              children: runsToDocx(block.runs.map((r) => ({ ...r, code: true }))),
            }),
          );
          break;
        case "hr":
          children.push(new Paragraph({ thematicBreak: true }));
          break;
        default:
          children.push(new Paragraph({ children: runsToDocx(block.runs) }));
      }
    }
  }

  if (input.bibliography.length > 0) {
    children.push(new Paragraph({ text: "References", heading: HeadingLevel.HEADING_1 }));
    for (const entry of input.bibliography) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: input.numericStyle ? `${entry.index}. ${entry.text}` : entry.text,
            }),
          ],
        }),
      );
    }
  }

  const numberedLevels = [0, 1, 2, 3].map((level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
  }));

  const doc = new Document({
    title: input.manuscriptTitle,
    description: `Manuscript export from Synthesis — ${input.projectTitle}`,
    numbering: {
      config: [
        {
          reference: BULLET_REF,
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: "•",
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
        // One numbering config PER ordered-list instance so numbering restarts per list.
        ...[...numberingConfigs].map((group) => ({
          reference: `manuscript-ol-${group}`,
          levels: numberedLevels,
        })),
      ],
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
