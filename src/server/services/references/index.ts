// Reference library (citation manager for the manuscript) — follows the exemplar service
// shape (src/server/services/orgs): zod schemas exported for routes, ctx first,
// requirePermission first line, mutations + audit in one transaction, tenant-scoped by-id
// loads (R9). The `csl` Json column (CSL-JSON) is the source of truth; scalar columns are
// denormalized via denormalizeCsl().

import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma, type Tx } from "@/server/db";
import { conflict, notFound, validationError } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import { requirePermission } from "@/server/permissions";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { parseRis } from "@/server/services/imports/parsers/ris";
import { parseBibtex } from "@/server/services/imports/parsers/bibtex";
import {
  CSL_STYLE_IDS,
  DEFAULT_STYLE_ID,
  formatBibliographyPure,
  isNumericStyle,
  type CslItem,
  type CslStyleId,
  type FormattedReference,
} from "@/server/csl/engine";
import { cslItemSchema, denormalizeCsl, citationToCsl, parsedRecordToCsl, type CslItemInput } from "./csl";
import { lookupDoi, lookupPmid } from "./lookup";
import { writeRis } from "./writers/ris";
import { writeBibtex } from "./writers/bibtex";

export { CSL_STYLES } from "@/server/csl/engine";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const tagsSchema = z.array(z.string().trim().min(1).max(50)).max(20);

export const createReferenceSchema = z.object({
  csl: cslItemSchema,
  tags: tagsSchema.optional(),
  notes: z.string().trim().max(2000).optional(),
  citationId: z.string().optional(),
});

export const updateReferenceSchema = z.object({
  csl: cslItemSchema.optional(),
  tags: tagsSchema.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});

export const lookupReferenceSchema = z.object({
  kind: z.enum(["doi", "pmid"]),
  value: z.string().trim().min(1).max(500),
});

export const importReferencesSchema = z.object({
  format: z.enum(["RIS", "BIBTEX"]),
  content: z.string().min(1).max(5_000_000),
});

export const addFromCitationsSchema = z.object({
  citationIds: z.array(z.string().min(1)).max(500).optional(), // omitted = all FT-included
});

export const bibliographySchema = z.object({
  styleId: z.enum(CSL_STYLE_IDS).optional(), // defaults to DEFAULT_STYLE_ID in the service
  referenceIds: z.array(z.string().min(1)).max(2000).optional(), // first-use order for numeric styles
});

export const listReferencesSchema = z.object({
  search: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(50).optional(),
});

export const exportReferencesSchema = z
  .object({
    format: z.enum(["ris", "bibtex", "csl-json", "bibliography"]),
    styleId: z.enum(CSL_STYLE_IDS).optional(),
  })
  .refine((q) => q.format !== "bibliography" || q.styleId !== undefined, {
    message: "styleId is required for a formatted bibliography export",
  });

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const referenceSelect = {
  id: true,
  csl: true,
  title: true,
  firstAuthor: true,
  year: true,
  doi: true,
  pmid: true,
  tags: true,
  notes: true,
  citationId: true,
  createdAt: true,
  updatedAt: true,
  addedBy: { select: { id: true, name: true } },
} satisfies Prisma.ReferenceEntrySelect;

function toJson(value: unknown): Prisma.InputJsonObject {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonObject;
}

async function loadReference(tx: Tx, projectId: string, referenceId: string) {
  const entry = await tx.referenceEntry.findFirst({ where: { id: referenceId, projectId } });
  if (!entry) throw notFound("Reference");
  return entry;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listReferences(
  ctx: Ctx,
  projectId: string,
  filter: z.infer<typeof listReferencesSchema> = {},
) {
  await requirePermission(ctx, projectId, "references.view");
  return prisma.referenceEntry.findMany({
    where: {
      projectId,
      ...(filter.tag ? { tags: { has: filter.tag } } : {}),
      ...(filter.search
        ? {
            OR: [
              { title: { contains: filter.search, mode: "insensitive" } },
              { firstAuthor: { contains: filter.search, mode: "insensitive" } },
              { doi: { contains: filter.search.toLowerCase() } },
            ],
          }
        : {}),
    },
    select: referenceSelect,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createReference(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof createReferenceSchema>,
) {
  await requirePermission(ctx, projectId, "references.manage");
  const csl = input.csl as CslItemInput;
  const denorm = denormalizeCsl(csl);

  if (denorm.doi) {
    const dupe = await prisma.referenceEntry.findFirst({
      where: { projectId, doi: denorm.doi },
      select: { id: true, title: true },
    });
    if (dupe) throw conflict(`A reference with this DOI already exists: “${dupe.title}”`);
  }
  if (denorm.pmid) {
    const dupe = await prisma.referenceEntry.findFirst({
      where: { projectId, pmid: denorm.pmid },
      select: { id: true, title: true },
    });
    if (dupe) throw conflict(`A reference with this PMID already exists: “${dupe.title}”`);
  }
  if (input.citationId) {
    const citation = await prisma.citation.findFirst({
      where: { id: input.citationId, projectId },
    });
    if (!citation) throw notFound("Citation");
  }

  return prisma.$transaction(async (tx) => {
    const entry = await tx.referenceEntry.create({
      data: {
        projectId,
        csl: toJson(csl),
        ...denorm,
        tags: input.tags ?? [],
        notes: input.notes ?? null,
        citationId: input.citationId ?? null,
        addedById: ctx.userId,
      },
    });
    // The stored CSL item's id must equal the row id (formatting keys on it).
    const withId = await tx.referenceEntry.update({
      where: { id: entry.id },
      data: { csl: toJson({ ...csl, id: entry.id }) },
      select: referenceSelect,
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ReferenceEntry",
      entityId: entry.id,
      action: AuditActions.REFERENCE_CREATED,
      newValue: { title: denorm.title, doi: denorm.doi, pmid: denorm.pmid },
    });
    return withId;
  });
}

export async function updateReference(
  ctx: Ctx,
  projectId: string,
  referenceId: string,
  input: z.infer<typeof updateReferenceSchema>,
) {
  await requirePermission(ctx, projectId, "references.manage");
  const before = await loadReference(prisma, projectId, referenceId);

  const csl = input.csl !== undefined ? (input.csl as CslItemInput) : undefined;
  const denorm = csl ? denormalizeCsl(csl) : null;
  if (denorm?.doi && denorm.doi !== before.doi) {
    const dupe = await prisma.referenceEntry.findFirst({
      where: { projectId, doi: denorm.doi, id: { not: referenceId } },
    });
    if (dupe) throw conflict("Another reference already has this DOI");
  }

  return prisma.$transaction(async (tx) => {
    const entry = await tx.referenceEntry.update({
      where: { id: before.id },
      data: {
        ...(csl ? { csl: toJson({ ...csl, id: before.id }), ...denorm } : {}),
        ...(input.tags !== undefined ? { tags: input.tags ?? [] } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      select: referenceSelect,
    });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ReferenceEntry",
      entityId: before.id,
      action: AuditActions.REFERENCE_UPDATED,
      previousValue: { title: before.title, tags: before.tags, notes: before.notes },
      newValue: { title: entry.title, tags: entry.tags, notes: entry.notes },
    });
    return entry;
  });
}

export async function deleteReference(ctx: Ctx, projectId: string, referenceId: string) {
  await requirePermission(ctx, projectId, "references.manage");
  const before = await loadReference(prisma, projectId, referenceId);
  return prisma.$transaction(async (tx) => {
    await tx.referenceEntry.delete({ where: { id: before.id } });
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "ReferenceEntry",
      entityId: before.id,
      action: AuditActions.REFERENCE_DELETED,
      previousValue: { title: before.title, doi: before.doi, pmid: before.pmid },
    });
    return { deleted: true };
  });
}

// ---------------------------------------------------------------------------
// Lookups + imports
// ---------------------------------------------------------------------------

// Read-only external preview (no audit). Returns duplicateOfId when the project already
// has an entry with the same DOI/PMID so the UI can warn before adding.
export async function lookupReference(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof lookupReferenceSchema>,
) {
  await requirePermission(ctx, projectId, "references.manage");
  const csl = input.kind === "doi" ? await lookupDoi(input.value) : await lookupPmid(input.value);
  const denorm = denormalizeCsl(csl);
  const existing = await prisma.referenceEntry.findFirst({
    where: {
      projectId,
      OR: [
        ...(denorm.doi ? [{ doi: denorm.doi }] : []),
        ...(denorm.pmid ? [{ pmid: denorm.pmid }] : []),
      ],
    },
    select: { id: true },
  });
  return { csl, duplicateOfId: existing?.id ?? null };
}

export async function importReferences(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof importReferencesSchema>,
) {
  await requirePermission(ctx, projectId, "references.manage");
  const { records, errors } =
    input.format === "RIS" ? parseRis(input.content) : parseBibtex(input.content);
  if (records.length === 0) {
    throw validationError("No parseable references found in the file", { errors });
  }

  const existing = await prisma.referenceEntry.findMany({
    where: { projectId },
    select: { doi: true, pmid: true },
  });
  const seenDois = new Set(existing.map((e) => e.doi).filter(Boolean));
  const seenPmids = new Set(existing.map((e) => e.pmid).filter(Boolean));

  let added = 0;
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const record of records) {
      let csl: CslItemInput;
      try {
        csl = parsedRecordToCsl(record);
      } catch {
        skipped += 1;
        continue;
      }
      const denorm = denormalizeCsl(csl);
      if ((denorm.doi && seenDois.has(denorm.doi)) || (denorm.pmid && seenPmids.has(denorm.pmid))) {
        skipped += 1;
        continue;
      }
      const entry = await tx.referenceEntry.create({
        data: {
          projectId,
          csl: toJson(csl),
          ...denorm,
          tags: [],
          addedById: ctx.userId,
        },
      });
      await tx.referenceEntry.update({
        where: { id: entry.id },
        data: { csl: toJson({ ...csl, id: entry.id }) },
      });
      if (denorm.doi) seenDois.add(denorm.doi);
      if (denorm.pmid) seenPmids.add(denorm.pmid);
      added += 1;
    }
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Project",
      entityId: projectId,
      action: AuditActions.REFERENCES_IMPORTED,
      metadata: { format: input.format, added, skipped, parseErrors: errors.length },
    });
  });
  return { added, skipped, parseErrors: errors.length };
}

// Mirror screening citations into the library. Default set = citations with a FULL_TEXT
// INCLUDE result (the studies that will actually be cited in the paper).
export async function addFromCitations(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof addFromCitationsSchema>,
) {
  await requirePermission(ctx, projectId, "references.manage");

  let citations;
  if (input.citationIds && input.citationIds.length > 0) {
    citations = await prisma.citation.findMany({
      where: { id: { in: input.citationIds }, projectId, status: "ACTIVE" },
    });
  } else {
    const ftStage = await prisma.screeningStage.findFirst({
      where: { projectId, type: "FULL_TEXT" },
    });
    citations = ftStage
      ? await prisma.citation.findMany({
          where: {
            projectId,
            status: "ACTIVE",
            stageResults: { some: { stageId: ftStage.id, outcome: "INCLUDE" } },
          },
          orderBy: { createdAt: "asc" },
        })
      : [];
  }

  const mirrored = new Set(
    (
      await prisma.referenceEntry.findMany({
        where: { projectId, citationId: { not: null } },
        select: { citationId: true },
      })
    ).map((e) => e.citationId),
  );
  const existingDois = new Set(
    (
      await prisma.referenceEntry.findMany({ where: { projectId }, select: { doi: true } })
    )
      .map((e) => e.doi)
      .filter(Boolean),
  );

  let added = 0;
  let skipped = 0;
  await prisma.$transaction(async (tx) => {
    for (const citation of citations) {
      if (mirrored.has(citation.id) || (citation.doi && existingDois.has(citation.doi))) {
        skipped += 1;
        continue;
      }
      let csl: CslItemInput;
      try {
        csl = citationToCsl(citation);
      } catch {
        skipped += 1;
        continue;
      }
      const denorm = denormalizeCsl(csl);
      const entry = await tx.referenceEntry.create({
        data: {
          projectId,
          csl: toJson(csl),
          ...denorm,
          tags: ["included-study"],
          citationId: citation.id,
          addedById: ctx.userId,
        },
      });
      await tx.referenceEntry.update({
        where: { id: entry.id },
        data: { csl: toJson({ ...csl, id: entry.id }) },
      });
      if (denorm.doi) existingDois.add(denorm.doi);
      added += 1;
    }
    if (added > 0 || citations.length > 0) {
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "Project",
        entityId: projectId,
        action: AuditActions.REFERENCES_IMPORTED,
        metadata: { source: "included_studies", added, skipped },
      });
    }
  });
  return { added, skipped };
}

// ---------------------------------------------------------------------------
// Formatting + export
// ---------------------------------------------------------------------------

function entryToCslItem(entry: { id: string; csl: unknown }): CslItem {
  const csl = (entry.csl ?? {}) as Record<string, unknown>;
  return { ...csl, id: entry.id, type: String(csl.type ?? "article-journal") } as CslItem;
}

// THE API the manuscript editor consumes: referenceIds in first-use order in → numbered,
// formatted entries + in-text markers out. Unaudited read (precedent: live PRISMA counts).
export async function formatBibliography(
  ctx: Ctx,
  projectId: string,
  input: z.infer<typeof bibliographySchema>,
): Promise<{ styleId: CslStyleId; numeric: boolean; entries: FormattedReference[] }> {
  await requirePermission(ctx, projectId, "references.view");
  const styleId = input.styleId ?? DEFAULT_STYLE_ID;
  const entries = await prisma.referenceEntry.findMany({
    where: {
      projectId,
      ...(input.referenceIds && input.referenceIds.length > 0
        ? { id: { in: input.referenceIds } }
        : {}),
    },
    select: { id: true, csl: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const items = entries.map(entryToCslItem);
  const formatted = formatBibliographyPure(items, styleId, input.referenceIds);
  return { styleId, numeric: isNumericStyle(styleId), entries: formatted.entries };
}

export async function exportReferences(
  ctx: Ctx,
  projectId: string,
  query: z.infer<typeof exportReferencesSchema>,
): Promise<{ filename: string; contentType: string; body: string }> {
  await requirePermission(ctx, projectId, "references.view");
  const entries = await prisma.referenceEntry.findMany({
    where: { projectId },
    select: { id: true, csl: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const items = entries.map(entryToCslItem);

  let filename: string;
  let contentType: string;
  let body: string;
  if (query.format === "ris") {
    filename = "references.ris";
    contentType = "application/x-research-info-systems";
    body = writeRis(items as unknown as CslItemInput[]);
  } else if (query.format === "bibtex") {
    filename = "references.bib";
    contentType = "application/x-bibtex";
    body = writeBibtex(items as unknown as CslItemInput[]);
  } else if (query.format === "csl-json") {
    filename = "references.json";
    contentType = "application/vnd.citationstyles.csl+json";
    body = JSON.stringify(items, null, 2);
  } else {
    const styleId = query.styleId ?? DEFAULT_STYLE_ID;
    const formatted = formatBibliographyPure(items, styleId);
    filename = `bibliography-${styleId}.txt`;
    contentType = "text/plain; charset=utf-8";
    body = formatted.entries
      .map((e) => (isNumericStyle(styleId) ? `${e.index}. ${e.text}` : e.text))
      .join("\n\n");
  }

  await prisma.$transaction(async (tx) => {
    await audit.record(tx, {
      projectId,
      userId: ctx.userId,
      entityType: "Project",
      entityId: projectId,
      action: AuditActions.REFERENCE_EXPORTED,
      metadata: { format: query.format, styleId: query.styleId ?? null, count: items.length },
    });
  });
  return { filename, contentType, body };
}
