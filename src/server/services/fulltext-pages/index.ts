// Server-side PDF text layer (anchor v2 phase): extract per-page text ONCE with
// pdfjs-dist (legacy build — no DOM deps in Node) and persist it as FullTextPage rows,
// so stored quote offsets always refer to OUR text rather than whatever pdf.js version
// a client happens to run.
//
// This is an INTERNAL service helper: callers (AI ingest, upsertValue, re-anchor
// backfill) hold their own permissions; ctx is taken for the audit row and projectId
// for tenant scoping (R9) only. Status machine per prisma TextLayerStatus:
//   PENDING → EXTRACTED         (>= 50 avg chars/page)
//   PENDING → NO_TEXT_LAYER     (scanned/image-only; whatever text WAS found is stored)
//   PENDING → FAILED            (parse/storage error; retryable via force)
// An attempt never leaves the row PENDING.

import { Prisma, type FullTextFile } from "@prisma/client";
import { prisma } from "@/server/db";
import { notFound } from "@/server/errors";
import type { Ctx } from "@/server/auth/session";
import * as audit from "@/server/services/audit";
import { AuditActions } from "@/server/services/audit";
import { getStorage } from "@/server/storage";

// Below this average, the "text layer" is treated as absent (stray OCR artifacts or
// page numbers only) — anchors stay page-level for such files.
const MIN_AVG_CHARS_PER_PAGE = 50;

export interface StoredPage {
  page: number; // 1-based
  text: string; // RAW extracted text (callers normalize via normalizeForMatch)
}

export interface EnsurePagesResult {
  file: FullTextFile; // post-extraction row (textStatus/pageCount/textVersion current)
  pages: StoredPage[];
  reused: boolean; // true when an existing EXTRACTED layer was returned untouched
}

// --- pdf.js text extraction -----------------------------------------------------

// Mirrors the client viewer's text assembly (src/components/pdf/pdf-viewer-impl.tsx
// loadPageText): join item.str, plus "\n" per hasEOL item. quote-match normalizes
// whitespace, so minor assembly drift between pdf.js versions cannot break matching.
async function extractPdfPages(bytes: Buffer): Promise<string[]> {
  // Dynamic import: the legacy build is Node-safe but heavyweight — load it only when
  // a file actually needs extraction. webpackIgnore keeps it OUT of the Next server
  // bundle (Node resolves it from node_modules at runtime) — bundling pdf.js server-side
  // trips its worker/DOM shims, and serverExternalPackages is off the table because it
  // would break the client viewer's worker-URL asset reference (see next.config.ts).
  const { getDocument } = (await import(
    /* webpackIgnore: true */ "pdfjs-dist/legacy/build/pdf.mjs"
  )) as typeof import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: new Uint8Array(bytes), // copy: pdf.js may transfer/detach its input buffer
    useWorkerFetch: false, // no worker server-side (pdf.js falls back to a fake worker)
    useSystemFonts: false,
    verbosity: 0, // errors only — silence standard-font warnings in server logs
  });
  try {
    const doc = await task.promise;
    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const parts: string[] = [];
      for (const item of content.items) {
        if (!("str" in item)) continue; // marked-content items carry no text
        parts.push(item.str);
        if (item.hasEOL) parts.push("\n");
      }
      pages.push(parts.join(""));
    }
    return pages;
  } finally {
    // getDocument holds worker/parse resources even without a real worker thread.
    await task.destroy().catch(() => undefined);
  }
}

// --- ensure ----------------------------------------------------------------------

export async function ensureFullTextPages(
  ctx: Ctx,
  projectId: string,
  fileId: string,
  opts: { force?: boolean } = {},
): Promise<EnsurePagesResult> {
  // R9: the file must belong to the caller's project — 404 otherwise.
  const file = await prisma.fullTextFile.findFirst({ where: { id: fileId, projectId } });
  if (!file) throw notFound("File");

  // Idempotent: an existing EXTRACTED layer is authoritative unless forced (stored
  // anchors carry its textVersion — re-extracting gratuitously would strand them).
  // NO_TEXT_LAYER is equally terminal: the bytes are immutable, so re-running would
  // only churn textVersion and spam the audit log with identical outcomes.
  if ((file.textStatus === "EXTRACTED" || file.textStatus === "NO_TEXT_LAYER") && !opts.force) {
    const rows = await prisma.fullTextPage.findMany({
      where: { fileId: file.id },
      orderBy: { page: "asc" },
      select: { page: true, text: true },
    });
    return { file, pages: rows, reused: true };
  }

  let pageTexts: string[];
  try {
    const bytes = await getStorage().get(file.storageKey);
    pageTexts = await extractPdfPages(bytes);
  } catch (err) {
    // Persist the failure (never leave PENDING after an attempt), audit it, rethrow.
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await prisma.$transaction(async (tx) => {
      await tx.fullTextFile.update({
        where: { id: file.id },
        data: { textStatus: "FAILED" },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "FullTextFile",
        entityId: file.id,
        action: AuditActions.FULLTEXT_TEXT_EXTRACTED,
        metadata: { status: "FAILED", textVersion: file.textVersion, error: message },
      });
    });
    throw err;
  }

  const pageCount = pageTexts.length;
  const totalChars = pageTexts.reduce((sum, t) => sum + t.length, 0);
  const status: "EXTRACTED" | "NO_TEXT_LAYER" =
    pageCount > 0 && totalChars / pageCount >= MIN_AVG_CHARS_PER_PAGE
      ? "EXTRACTED"
      : "NO_TEXT_LAYER";

  let updated;
  try {
    updated = await prisma.$transaction(async (tx) => {
      // Full replace: page rows always belong to exactly one textVersion.
      await tx.fullTextPage.deleteMany({ where: { fileId: file.id } });
      if (pageCount > 0) {
        await tx.fullTextPage.createMany({
          data: pageTexts.map((text, i) => ({ fileId: file.id, page: i + 1, text })),
        });
      }
      const row = await tx.fullTextFile.update({
        where: { id: file.id },
        data: { textStatus: status, pageCount, textVersion: { increment: 1 } },
      });
      await audit.record(tx, {
        projectId,
        userId: ctx.userId,
        entityType: "FullTextFile",
        entityId: file.id,
        action: AuditActions.FULLTEXT_TEXT_EXTRACTED,
        metadata: { status, pageCount, textVersion: row.textVersion },
      });
      return row;
    });
  } catch (err) {
    // Two concurrent first-time extractions can collide on @@unique([fileId, page])
    // (delete+createMany race). The loser adopts the winner's identical result — the
    // bytes are immutable, so both extractions produced the same pages.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.fullTextFile.findUniqueOrThrow({ where: { id: file.id } });
      const rows = await prisma.fullTextPage.findMany({
        where: { fileId: file.id },
        orderBy: { page: "asc" },
        select: { page: true, text: true },
      });
      return { file: winner, pages: rows, reused: true };
    }
    throw err;
  }

  return {
    file: updated,
    pages: pageTexts.map((text, i) => ({ page: i + 1, text })),
    reused: false,
  };
}
