// Per-citation OA auto-fetch: resolve a candidate PDF URL per source, download with
// strict validation, and feed the bytes through the EXISTING uploadFullText path (50 MB
// cap, %PDF- magic, sha256 dedup, storage, fulltext.file.uploaded audit — all reused).
// Retrieval-attempt rows created here are machine output and are NOT individually
// audited (run-level audit only; same rationale as AI suggestion rows).

import { prisma } from "@/server/db";
import type { Ctx } from "@/server/auth/session";
import { getHttpClient, politeHeaders } from "@/server/http/client";
import { MAX_PDF_BYTES, uploadFullText } from "@/server/services/fulltext";
import { resolveEuropePmcPdf, resolveUnpaywallPdf, type OaSource } from "./sources";

const DOWNLOAD_TIMEOUT_MS = 15_000;
const NOTES_MAX = 2000;
const PDF_MAGIC = "%PDF-";

export interface AutoFetchCitation {
  id: string;
  doi: string | null;
  pmid: string | null;
  hasFile: boolean;
}

export interface AutoFetchResult {
  outcome: "RETRIEVED" | "NOT_RETRIEVED" | "SKIPPED";
  source?: OaSource;
  fileId?: string;
  notes: string;
}

function safeFilename(source: OaSource, citation: AutoFetchCitation): string {
  const idPart = (citation.doi ?? citation.pmid ?? citation.id).replace(/[^a-zA-Z0-9._-]/g, "-");
  return `${source}-${idPart}.pdf`.slice(0, 180);
}

// Caller has already passed requirePermission("fulltext.manage") — this runs network I/O
// outside any transaction and writes each outcome in its own small tx via the services.
export async function attemptAutoFetch(
  ctx: Ctx,
  projectId: string,
  citation: AutoFetchCitation,
): Promise<AutoFetchResult> {
  if (citation.hasFile) {
    return { outcome: "SKIPPED", notes: "A full-text file is already attached" };
  }
  if (!citation.doi && !citation.pmid) {
    return { outcome: "SKIPPED", notes: "No DOI or PMID to search by" };
  }

  const http = getHttpClient();
  const tried: string[] = [];

  const resolvers: { source: OaSource; resolve: () => Promise<string | null> }[] = [
    {
      source: "unpaywall",
      resolve: () =>
        citation.doi ? resolveUnpaywallPdf(http, citation.doi) : Promise.resolve(null),
    },
    {
      source: "europepmc",
      resolve: () => resolveEuropePmcPdf(http, { pmid: citation.pmid, doi: citation.doi }),
    },
  ];

  for (const { source, resolve } of resolvers) {
    let pdfUrl: string | null = null;
    try {
      pdfUrl = await resolve();
    } catch (err) {
      tried.push(`${source}: lookup failed (${errorMessage(err)})`);
      continue;
    }
    if (!pdfUrl) {
      tried.push(`${source}: no open-access PDF location`);
      continue;
    }

    try {
      const res = await http.fetchBytes(pdfUrl, {
        headers: politeHeaders(),
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        maxBytes: MAX_PDF_BYTES,
      });
      if (res.status < 200 || res.status >= 300) {
        tried.push(`${source}: download returned HTTP ${res.status}`);
        continue;
      }
      if (res.bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC) {
        tried.push(`${source}: response was not a PDF (${res.contentType ?? "unknown type"})`);
        continue;
      }

      const uploaded = await uploadFullText(ctx, projectId, {
        citationId: citation.id,
        filename: safeFilename(source, citation),
        bytes: res.bytes,
        label: `Auto-fetched (${source})`,
      });
      const notes = `Downloaded from ${pdfUrl}`.slice(0, NOTES_MAX);
      await prisma.fullTextRetrievalAttempt.create({
        data: {
          citationId: citation.id,
          method: source,
          outcome: "RETRIEVED",
          notes,
          recordedById: ctx.userId,
        },
      });
      return { outcome: "RETRIEVED", source, fileId: uploaded.file.id, notes };
    } catch (err) {
      tried.push(`${source}: download failed (${errorMessage(err)})`);
    }
  }

  const notes = `Tried: ${tried.join("; ") || "no sources applicable"}`.slice(0, NOTES_MAX);
  await prisma.fullTextRetrievalAttempt.create({
    data: {
      citationId: citation.id,
      method: "oa-autofetch",
      outcome: "NOT_RETRIEVED",
      notes,
      recordedById: ctx.userId,
    },
  });
  return { outcome: "NOT_RETRIEVED", notes };
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
