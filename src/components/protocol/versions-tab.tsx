"use client";

// Versions & amendments tab (read-only):
// GET /protocol/versions — immutable snapshots frozen at publish/amendment time.
// GET /protocol/amendments — documented changes; fromVersion 0 = made while still a draft.

import { useEffect, useState } from "react";
import { FileClock, History } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AmendmentRow, VersionRow } from "./types";

// Snapshots store { protocol: { criteria, outcomes, picoQuestions }, exclusionReasons, … };
// summarize defensively — shape is server-owned JSON.
function snapshotSummary(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const root = snapshot as {
    protocol?: { criteria?: unknown; outcomes?: unknown; picoQuestions?: unknown } | null;
    exclusionReasons?: unknown;
  };
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  const p = root.protocol;
  if (typeof p !== "object" || p === null) return null;
  return [
    `${len(p.criteria)} criteria`,
    `${len(p.outcomes)} outcomes`,
    `${len(p.picoQuestions)} PICO`,
    `${len(root.exclusionReasons)} exclusion reasons`,
  ].join(" · ");
}

export function VersionsTab({
  projectId,
  latestVersionNumber,
}: {
  projectId: string;
  latestVersionNumber: number;
}) {
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [amendments, setAmendments] = useState<AmendmentRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<VersionRow[]>(`/api/projects/${projectId}/protocol/versions`)
      .then((rows) => {
        if (!cancelled) setVersions(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setVersions([]);
          toast.error("Failed to load protocol versions");
        }
      });
    api<AmendmentRow[]>(`/api/projects/${projectId}/protocol/amendments`)
      .then((rows) => {
        if (!cancelled) setAmendments(rows);
      })
      .catch(() => {
        if (!cancelled) {
          setAmendments([]);
          toast.error("Failed to load amendments");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium">Version history</h2>
          <p className="text-sm text-muted-foreground">
            Immutable snapshots of the whole protocol, frozen on publish and by each amendment.
          </p>
        </div>
        {versions === null ? (
          <Skeleton className="h-40" />
        ) : versions.length === 0 ? (
          <EmptyState
            icon={History}
            title="No versions yet"
            description="Publish the protocol to freeze version 1 as the preregistered record."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Version</TableHead>
                <TableHead>Frozen</TableHead>
                <TableHead>By</TableHead>
                <TableHead>Contents</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">v{v.versionNumber}</span>
                      {v.versionNumber === latestVersionNumber && (
                        <Badge variant="include">current</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDateTime(v.createdAt)}
                  </TableCell>
                  <TableCell>{v.createdBy.name}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {snapshotSummary(v.snapshot) ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-medium">Amendments</h2>
          <p className="text-sm text-muted-foreground">
            Documented protocol changes. Each amendment freezes the next version with its
            rationale.
          </p>
        </div>
        {amendments === null ? (
          <Skeleton className="h-32" />
        ) : amendments.length === 0 ? (
          <EmptyState
            icon={FileClock}
            title="No amendments recorded"
            description="Once screening has begun, every protocol change requires a rationale and is listed here."
          />
        ) : (
          <ul className="space-y-3">
            {amendments.map((a) => (
              <li key={a.id} className="rounded-lg border border-border bg-card p-4">
                <Badge variant="outline">
                  {a.fromVersion === 0
                    ? `unpublished draft → v${a.toVersion}`
                    : `v${a.fromVersion} → v${a.toVersion}`}
                </Badge>
                <p className="mt-2 text-sm font-medium">{a.reason}</p>
                {a.description && (
                  <p className="mt-1 text-sm text-muted-foreground">{a.description}</p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  {a.createdBy.name} · {formatDateTime(a.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
