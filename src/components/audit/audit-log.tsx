"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, History, ShieldAlert, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { ActionBadge } from "@/components/audit/action-badge";
import { DiffViewer } from "@/components/audit/diff-viewer";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Alert, EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Blinded fields (previousValue/newValue/metadata/reason) are optional: the API filters
// sensitive rows server-side and we render exactly what it returns.
interface AuditEventRow {
  id: string;
  entityType: string;
  entityId: string;
  action: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  metadata?: unknown;
  createdAt: string;
  actor: { id: string; name: string };
}

interface AuditEventPage {
  events: AuditEventRow[];
  nextCursor: string | null;
}

interface MemberRow {
  id: string;
  userId: string;
  status: string;
  user: { id: string; name: string };
}

// Mirrors the audit action catalog (src/server/services/audit/actions.ts) — the only values
// the API ever writes. "All …" entries use the route's actionPrefix (startsWith) filter.
// Org-level actions (org.*, user.created) never carry a projectId, so they are omitted.
const ACTION_GROUPS: { label: string; allPrefix?: string; actions: string[] }[] = [
  {
    label: "Project & team",
    actions: [
      "project.created",
      "project.updated",
      "member.added",
      "member.roles_changed",
      "member.removed",
      "invitation.created",
      "invitation.accepted",
      "invitation.revoked",
    ],
  },
  {
    label: "Protocol",
    allPrefix: "protocol.",
    actions: [
      "protocol.updated",
      "protocol.published",
      "protocol.amended",
      "protocol.criterion.created",
      "protocol.criterion.updated",
      "protocol.criterion.deleted",
      "protocol.outcome.created",
      "protocol.outcome.updated",
      "protocol.outcome.deleted",
      "protocol.pico.created",
      "protocol.pico.updated",
      "protocol.pico.deleted",
    ],
  },
  {
    label: "Exclusion reasons",
    allPrefix: "exclusion_reason.",
    actions: [
      "exclusion_reason.created",
      "exclusion_reason.updated",
      "exclusion_reason.deleted",
    ],
  },
  {
    label: "Import",
    allPrefix: "import.",
    actions: ["import.batch.created", "import.batch.committed", "import.batch.failed"],
  },
  {
    label: "Deduplication",
    allPrefix: "dedup.",
    actions: ["dedup.run", "dedup.merged", "dedup.rejected", "dedup.merge_undone"],
  },
  {
    label: "Screening",
    allPrefix: "screening.",
    actions: [
      "screening.assigned",
      "screening.decision.created",
      "screening.decision.updated",
      "screening.conflict.opened",
      "screening.conflict.reopened",
      "screening.conflict.adjudicated",
      "screening.result.created",
      "screening.result.reopened",
      "screening.stage.updated",
      "screening.stage.unblinded",
    ],
  },
  {
    label: "Full text",
    allPrefix: "fulltext.",
    actions: [
      "fulltext.file.uploaded",
      "fulltext.file.linked",
      "fulltext.retrieval.recorded",
    ],
  },
  {
    label: "Studies",
    allPrefix: "study.",
    actions: ["study.created", "study.updated", "study.report_linked", "study.report_unlinked"],
  },
  {
    label: "Extraction",
    allPrefix: "extraction.",
    actions: [
      "extraction.template.created",
      "extraction.template.updated",
      "extraction.template.published",
      "extraction.field.created",
      "extraction.field.updated",
      "extraction.field.deleted",
      "extraction.assigned",
      "extraction.form.started",
      "extraction.form.completed",
      "extraction.value.created",
      "extraction.value.updated",
      "extraction.conflict.opened",
      "extraction.conflict.adjudicated",
    ],
  },
  {
    label: "Risk of bias",
    allPrefix: "rob.",
    actions: [
      "rob.tool.created",
      "rob.tool.updated",
      "rob.tool.published",
      "rob.assigned",
      "rob.assessment.started",
      "rob.assessment.completed",
      "rob.judgment.created",
      "rob.judgment.updated",
      "rob.conflict.opened",
      "rob.conflict.adjudicated",
    ],
  },
  {
    label: "Reports & exports",
    actions: ["prisma.snapshot.created", "export.created"],
  },
];

function truncateId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

export function AuditLog({ projectId }: { projectId: string }) {
  const [events, setEvents] = useState<AuditEventRow[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Filters
  const [entityType, setEntityType] = useState("");
  const [actionPrefix, setActionPrefix] = useState("");
  const [actorId, setActorId] = useState("");

  // Distinct entity types seen across loaded pages (grow-only) → filter options.
  const [seenTypes, setSeenTypes] = useState<string[]>([]);

  const noteTypes = useCallback((rows: AuditEventRow[]) => {
    setSeenTypes((prev) => {
      const next = new Set(prev);
      for (const row of rows) next.add(row.entityType);
      return next.size === prev.length ? prev : [...next].sort();
    });
  }, []);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (entityType) params.set("entityType", entityType);
    if (actionPrefix) params.set("actionPrefix", actionPrefix);
    if (actorId) params.set("userId", actorId);
    return params;
  }, [entityType, actionPrefix, actorId]);

  useEffect(() => {
    let cancelled = false;
    setEvents(null);
    setNextCursor(null);
    setExpandedId(null);
    const qs = query.toString();
    api<AuditEventPage>(`/api/projects/${projectId}/audit${qs ? `?${qs}` : ""}`)
      .then((page) => {
        if (cancelled) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
        noteTypes(page.events);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
        } else {
          toast.error(err instanceof ApiError ? err.message : "Failed to load audit events");
        }
        setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, query, noteTypes]);

  useEffect(() => {
    api<MemberRow[]>(`/api/projects/${projectId}/members`)
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [projectId]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams(query);
      params.set("cursor", nextCursor);
      const page = await api<AuditEventPage>(
        `/api/projects/${projectId}/audit?${params.toString()}`,
      );
      setEvents((prev) => [...(prev ?? []), ...page.events]);
      setNextCursor(page.nextCursor);
      noteTypes(page.events);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load more events");
    } finally {
      setLoadingMore(false);
    }
  }

  const hasFilters = Boolean(entityType || actionPrefix || actorId);
  const typeOptions =
    entityType && !seenTypes.includes(entityType)
      ? [...seenTypes, entityType].sort()
      : seenTypes;

  if (forbidden) {
    return (
      <div>
        <PageHeader
          title="Audit trail"
          description="Chronological record of every change in this project."
        />
        <Alert variant="warning">
          You don&apos;t have permission to view the audit trail. Ask a project admin if you need
          access.
        </Alert>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Audit trail"
        description="Chronological record of every change in this project."
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56 space-y-1.5">
          <Label htmlFor="audit-entity-type">Entity type</Label>
          <Select
            id="audit-entity-type"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
          >
            <option value="">All entity types</option>
            {typeOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-72 space-y-1.5">
          <Label htmlFor="audit-action">Action</Label>
          <Select
            id="audit-action"
            value={actionPrefix}
            onChange={(e) => setActionPrefix(e.target.value)}
          >
            <option value="">All actions</option>
            {ACTION_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.allPrefix && (
                  <option value={group.allPrefix}>All {group.label.toLowerCase()} events</option>
                )}
                {group.actions.map((action) => (
                  <option key={action} value={action}>
                    {action}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </div>
        <div className="w-56 space-y-1.5">
          <Label htmlFor="audit-actor">Actor</Label>
          <Select id="audit-actor" value={actorId} onChange={(e) => setActorId(e.target.value)}>
            <option value="">All members</option>
            {(members ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.user.name}
                {m.status !== "ACTIVE" ? " (removed)" : ""}
              </option>
            ))}
          </Select>
        </div>
        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="mb-0.5"
            onClick={() => {
              setEntityType("");
              setActionPrefix("");
              setActorId("");
            }}
          >
            <X /> Reset
          </Button>
        )}
      </div>

      {events === null ? (
        <Skeleton className="h-72" />
      ) : events.length === 0 ? (
        <EmptyState
          icon={History}
          title={hasFilters ? "No matching events" : "No audit events yet"}
          description={
            hasFilters
              ? "Try clearing or broadening the filters above."
              : "Changes to the project — imports, screening decisions, settings edits — will appear here."
          }
        />
      ) : (
        <div className="rounded-lg border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => {
                const expanded = expandedId === event.id;
                return (
                  <Fragment key={event.id}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedId(expanded ? null : event.id)}
                    >
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                      </TableCell>
                      <TableCell className="font-medium">{event.actor.name}</TableCell>
                      <TableCell>
                        <ActionBadge action={event.action} />
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{event.entityType}</span>{" "}
                        <span
                          className="font-mono text-xs text-muted-foreground"
                          title={event.entityId}
                        >
                          {truncateId(event.entityId)}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[280px] truncate text-muted-foreground">
                        {event.reason ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {expanded ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="bg-muted/30 p-4">
                          <div className="space-y-3">
                            <p className="font-mono text-xs text-muted-foreground">
                              {event.entityType} · {event.entityId}
                            </p>
                            {event.reason && (
                              <p className="text-sm">
                                <span className="font-medium">Reason:</span> {event.reason}
                              </p>
                            )}
                            <DiffViewer
                              previousValue={event.previousValue ?? null}
                              newValue={event.newValue ?? null}
                              metadata={event.metadata}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {nextCursor && events !== null && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={loadMore} disabled={loadingMore}>
            {loadingMore && <Spinner />} Load more
          </Button>
        </div>
      )}

      <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Events for blinded work products (screening decisions, extraction and risk-of-bias
        records) are visible only to their author and to members with adjudication or admin
        rights — this view may omit some events.
      </p>
    </div>
  );
}
