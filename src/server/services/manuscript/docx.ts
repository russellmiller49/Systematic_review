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

// Guideline part: the parent (heading null, sections at H1) or one PICO sub-project
// (heading + optional research-question subtitle at H1, sections demoted to H2).
export interface DocxPartInput {
  heading: string | null;
  subtitle?: string | null;
  sections: DocxSectionInput[];
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

// In-content headings sit one level below their section title: heading2/heading3 →
// H2/H3 normally, H3/H4 when the section itself is demoted (guideline PICO parts).
function appendBlocks(
  children: Paragraph[],
  blocks: DocxBlock[],
  numberingConfigs: Set<number>,
  demote: boolean,
) {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading2":
        children.push(
          new Paragraph({
            children: runsToDocx(block.runs),
            heading: demote ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
          }),
        );
        break;
      case "heading3":
        children.push(
          new Paragraph({
            children: runsToDocx(block.runs),
            heading: demote ? HeadingLevel.HEADING_4 : HeadingLevel.HEADING_3,
          }),
        );
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

function appendBibliography(
  children: Paragraph[],
  bibliography: DocxBibliographyEntry[],
  numericStyle: boolean,
) {
  if (bibliography.length === 0) return;
  children.push(new Paragraph({ text: "References", heading: HeadingLevel.HEADING_1 }));
  for (const entry of bibliography) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: numericStyle ? `${entry.index}. ${entry.text}` : entry.text }),
        ],
      }),
    );
  }
}

function buildDocument(input: {
  projectTitle: string;
  manuscriptTitle: string;
  children: Paragraph[];
  numberingConfigs: Set<number>;
}): Promise<Uint8Array> {
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
        ...[...input.numberingConfigs].map((group) => ({
          reference: `manuscript-ol-${group}`,
          levels: numberedLevels,
        })),
      ],
    },
    sections: [{ children: input.children }],
  });

  return Packer.toBuffer(doc);
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
    appendBlocks(children, section.blocks, numberingConfigs, false);
  }

  appendBibliography(children, input.bibliography, input.numericStyle);
  return buildDocument({ ...input, children, numberingConfigs });
}

// Whole-guideline document: parent sections at H1, then each PICO part under its own H1
// with the part's sections at H2 and in-content headings demoted one level. A single
// bibliography (numbered across the entire document) closes the file.
export async function buildGuidelineDocx(input: {
  projectTitle: string;
  manuscriptTitle: string;
  parts: DocxPartInput[];
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

  for (const part of input.parts) {
    const demote = part.heading !== null;
    if (part.heading !== null) {
      children.push(new Paragraph({ text: part.heading, heading: HeadingLevel.HEADING_1 }));
      if (part.subtitle) {
        children.push(
          new Paragraph({ children: [new TextRun({ text: part.subtitle, italics: true })] }),
        );
      }
    }
    for (const section of part.sections) {
      if (section.kind !== "TITLE_PAGE") {
        children.push(
          new Paragraph({
            text: section.title,
            heading: demote ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_1,
          }),
        );
      }
      appendBlocks(children, section.blocks, numberingConfigs, demote);
    }
  }

  appendBibliography(children, input.bibliography, input.numericStyle);
  return buildDocument({ ...input, children, numberingConfigs });
}
