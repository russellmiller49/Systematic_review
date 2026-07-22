"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { Editor } from "@tiptap/react";
import { BookMarked, History, Lock, Pencil, Save, Square } from "lucide-react";
import { toast } from "sonner";
import { api, apiDelete, apiPost, apiPut, ApiError } from "@/lib/api";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_INTERVAL_MS,
  LOCK_HEARTBEAT_INTERVAL_MS,
} from "@/lib/manuscript/lock-rules";
import { Alert, Skeleton, Spinner } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { CitationPicker } from "./citation-picker";
import { VersionHistoryDialog } from "./version-history";
import {
  SECTION_STATUS_LABEL,
  SECTION_STATUS_VARIANT,
  type MemberRef,
  type SectionDetail,
  type SectionStatus,
  type UserRef,
} from "./types";

const ManuscriptEditor = dynamic(() => import("./editor"), {
  ssr: false,
  loading: () => <Skeleton className="mt-3 h-64" />,
});

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

// Owns the editing session: acquire lock → heartbeat every 30s → autosave (2s debounce /
// 10s max) with baseVersion optimistic concurrency → release on stop/unmount (keepalive;
// the 90s stale TTL is the real recovery).
export function SectionEditor({
  projectId,
  sectionId,
  me,
  members,
  canManage,
  onChanged,
  onCitationsChanged,
}: {
  projectId: string;
  sectionId: string;
  me: UserRef | null;
  members: MemberRef[];
  canManage: boolean;
  onChanged: () => void;
  onCitationsChanged: () => void;
}) {
  const base = `/api/projects/${projectId}/manuscript/sections/${sectionId}`;
  const [section, setSection] = useState<SectionDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [takeoverOffered, setTakeoverOffered] = useState(false);
  const [conflictVersion, setConflictVersion] = useState<number | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const baseVersionRef = useRef(0);
  const pendingDocRef = useRef<unknown>(null);
  const lastSaveAtRef = useRef(0);
  const debounceRef = useRef<number | null>(null);
  const editingRef = useRef(false);
  editingRef.current = editing;

  const load = useCallback(async () => {
    try {
      const detail = await api<SectionDetail>(base);
      setSection(detail);
      baseVersionRef.current = detail.version;
      return detail;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load the section");
      return null;
    }
  }, [base]);

  // Section switched: hard reset local editing state.
  useEffect(() => {
    setSection(null);
    setEditing(false);
    setSaveState("idle");
    setTakeoverOffered(false);
    setConflictVersion(null);
    pendingDocRef.current = null;
    load();
  }, [load]);

  const flushSave = useCallback(async () => {
    const doc = pendingDocRef.current;
    if (!editingRef.current || doc === null) return;
    pendingDocRef.current = null;
    setSaveState("saving");
    try {
      const res = await apiPut<{ version: number; wordCount: number }>(`${base}/content`, {
        content: doc,
        baseVersion: baseVersionRef.current,
      });
      baseVersionRef.current = res.version;
      lastSaveAtRef.current = Date.now();
      setSaveState(pendingDocRef.current ? "dirty" : "saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = err.details as { reason?: string; currentVersion?: number } | undefined;
        if (details?.reason === "VERSION_MISMATCH") {
          setConflictVersion(details.currentVersion ?? null);
        } else {
          toast.error(err.message);
          setEditing(false);
        }
        setSaveState("error");
      } else {
        setSaveState("error");
      }
    }
  }, [base]);

  const scheduleSave = useCallback(
    (doc: unknown) => {
      pendingDocRef.current = doc;
      setSaveState("dirty");
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      const overdue = Date.now() - lastSaveAtRef.current > AUTOSAVE_MAX_INTERVAL_MS;
      debounceRef.current = window.setTimeout(
        () => void flushSave(),
        overdue ? 0 : AUTOSAVE_DEBOUNCE_MS,
      );
    },
    [flushSave],
  );

  // While read-only, poll for lock/status changes (10s visible + focus refetch — app
  // convention) so presence banners clear when the other editor finishes.
  useEffect(() => {
    if (editing) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 10_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [editing, load]);

  // Heartbeat while editing.
  useEffect(() => {
    if (!editing) return;
    const timer = window.setInterval(() => {
      apiPut(`${base}/lock`, {}).catch(() => {
        toast.error("Your edit lock was lost — the section is now read-only");
        setEditing(false);
        load();
      });
    }, LOCK_HEARTBEAT_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [editing, base, load]);

  // Best-effort lock release on unmount/navigation; the stale TTL is the real recovery.
  useEffect(() => {
    if (!editing) return;
    const release = () => {
      void fetch(`${base}/lock`, { method: "DELETE", keepalive: true, credentials: "same-origin" });
    };
    window.addEventListener("beforeunload", release);
    return () => {
      window.removeEventListener("beforeunload", release);
      release();
    };
  }, [editing, base]);

  async function startEditing(takeover = false) {
    setBusy(true);
    try {
      const res = await apiPost<{ lock: unknown; version: number }>(`${base}/lock`, { takeover });
      baseVersionRef.current = res.version;
      lastSaveAtRef.current = Date.now();
      setTakeoverOffered(false);
      setConflictVersion(null);
      const detail = await load();
      if (detail) setEditing(true);
      setSaveState("idle");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const details = err.details as { stale?: boolean } | undefined;
        setTakeoverOffered(Boolean(details?.stale));
        toast.error(err.message);
        load();
      } else {
        toast.error(err instanceof ApiError ? err.message : "Could not start editing");
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopEditing() {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    await flushSave();
    setEditing(false);
    try {
      await apiDelete(`${base}/lock`);
    } catch {
      // The stale TTL recovers abandoned locks.
    }
    await load();
    onChanged();
  }

  async function saveVersion() {
    const note = window.prompt("Optional note for this version:")?.trim();
    try {
      await apiPost(`${base}/versions`, note ? { note } : {});
      toast.success("Version saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save a version");
    }
  }

  async function setStatus(status: SectionStatus) {
    try {
      await apiPut(`${base}/status`, { status });
      toast.success(`Section marked ${SECTION_STATUS_LABEL[status].toLowerCase()}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to change the status");
    }
  }

  async function assign(assigneeId: string | null) {
    try {
      await apiPut(`${base}/assignee`, { assigneeId });
      toast.success(assigneeId ? "Section assigned" : "Assignment cleared");
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to assign the section");
    }
  }

  async function reloadAfterConflict() {
    setConflictVersion(null);
    setEditing(false);
    pendingDocRef.current = null;
    await load();
  }

  function insertCitation(referenceIds: string[]) {
    editorRef.current
      ?.chain()
      .focus()
      .insertContent({ type: "citation", attrs: { referenceIds } })
      .run();
    onCitationsChanged();
  }

  if (!section) {
    return <Skeleton className="h-96" />;
  }

  const lockHeldByOther =
    section.lock !== null && section.lock.userId !== me?.id && !section.lock.stale;
  const lockStaleFromOther =
    section.lock !== null && section.lock.userId !== me?.id && section.lock.stale;

  const saveLabel: Record<SaveState, string> = {
    idle: "",
    dirty: "Unsaved changes…",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed",
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold">{section.title}</h2>
          <Badge variant={SECTION_STATUS_VARIANT[section.status]}>
            {SECTION_STATUS_LABEL[section.status]}
          </Badge>
          <span className="text-xs text-muted-foreground">{section.wordCount} words</span>
          {editing && (
            <span
              className={
                saveState === "error"
                  ? "text-xs font-medium text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {saveLabel[saveState]}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {canManage && (
            <Select
              aria-label="Assignee"
              className="h-8 w-40 text-xs"
              value={section.assignee?.id ?? ""}
              onChange={(e) => void assign(e.target.value || null)}
            >
              <option value="">Unassigned</option>
              {members
                .filter((m) => m.status === "ACTIVE")
                .map((m) => (
                  <option key={m.user.id} value={m.user.id}>
                    {m.user.name}
                  </option>
                ))}
            </Select>
          )}
          {(section.canEdit || canManage) && section.status !== "APPROVED" && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void setStatus(section.status === "DRAFT" ? "IN_REVIEW" : "DRAFT")}
            >
              {section.status === "DRAFT" ? "Submit for review" : "Back to draft"}
            </Button>
          )}
          {canManage &&
            (section.status === "APPROVED" ? (
              <Button variant="outline" size="sm" onClick={() => void setStatus("IN_REVIEW")}>
                Reopen
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={() => void setStatus("APPROVED")}>
                Approve
              </Button>
            ))}
          <Button variant="ghost" size="sm" onClick={() => setHistoryOpen(true)}>
            <History /> History
          </Button>
          {editing ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void saveVersion()}>
                <Save /> Save version
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void stopEditing()}>
                <Square /> Done editing
              </Button>
            </>
          ) : (
            section.canEdit &&
            !lockHeldByOther && (
              <Button size="sm" disabled={busy} onClick={() => void startEditing()}>
                {busy ? <Spinner className="h-3.5 w-3.5" /> : <Pencil />} Edit
              </Button>
            )
          )}
        </div>
      </div>

      {lockHeldByOther && section.lock && (
        <Alert variant="info" className="mt-3">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="h-3.5 w-3.5" />
            {section.lock.name} is editing this section
            {section.lock.acquiredAt
              ? ` — started ${new Date(section.lock.acquiredAt).toLocaleTimeString()}`
              : ""}
            .
          </span>
        </Alert>
      )}
      {(lockStaleFromOther || takeoverOffered) && section.canEdit && !editing && section.lock && (
        <Alert variant="warning" className="mt-3">
          <span className="flex flex-wrap items-center gap-2">
            {section.lock.name}&apos;s editing session looks idle.
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void startEditing(true)}>
              Take over editing
            </Button>
          </span>
        </Alert>
      )}
      {conflictVersion !== null && (
        <Alert variant="error" className="mt-3">
          <span className="flex flex-wrap items-center gap-2">
            This section changed elsewhere (now v{conflictVersion}) — your last change was not
            saved. Copy any unsaved text, then reload.
            <Button variant="outline" size="sm" onClick={() => void reloadAfterConflict()}>
              Reload latest
            </Button>
          </span>
        </Alert>
      )}

      <ManuscriptEditor
        key={`${section.id}:${editing ? "edit" : `read-${section.version}`}`}
        initialContent={section.content}
        editable={editing}
        onDocChange={scheduleSave}
        onReady={(editor) => {
          editorRef.current = editor;
        }}
        toolbarExtra={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => setPickerOpen(true)}
            title="Insert citation from the reference library"
          >
            <BookMarked /> Cite
          </Button>
        }
      />

      <VersionHistoryDialog
        projectId={projectId}
        sectionId={section.id}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        canRestore={editing}
        onRestored={() => {
          void load();
          onChanged();
        }}
      />
      <CitationPicker
        projectId={projectId}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onInsert={insertCitation}
      />
    </div>
  );
}
