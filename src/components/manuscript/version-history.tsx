"use client";

import { useCallback, useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { api, apiPost, ApiError } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import type { VersionSummary } from "./types";

const ORIGIN_LABEL: Record<VersionSummary["origin"], string> = {
  EXPLICIT: "Saved version",
  LOCK_RELEASE: "Session end",
  TAKEOVER: "Before takeover",
  RESTORE: "Before restore",
};

export function VersionHistoryDialog({
  projectId,
  sectionId,
  open,
  onOpenChange,
  canRestore,
  onRestored,
}: {
  projectId: string;
  sectionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canRestore: boolean; // caller must hold the edit lock
  onRestored: () => void;
}) {
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [previewText, setPreviewText] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<VersionSummary[]>(
      `/api/projects/${projectId}/manuscript/sections/${sectionId}/versions`,
    )
      .then(setVersions)
      .catch((err) => {
        setVersions([]);
        toast.error(err instanceof ApiError ? err.message : "Failed to load version history");
      });
  }, [projectId, sectionId]);

  useEffect(() => {
    if (open) {
      setVersions(null);
      setPreviewText({});
      load();
    }
  }, [open, load]);

  async function preview(versionId: string) {
    try {
      const version = await api<{ contentText: string }>(
        `/api/projects/${projectId}/manuscript/sections/${sectionId}/versions/${versionId}`,
      );
      setPreviewText((prev) => ({ ...prev, [versionId]: version.contentText || "(empty)" }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to load the version");
    }
  }

  async function restore(versionId: string) {
    setBusyId(versionId);
    try {
      await apiPost(
        `/api/projects/${projectId}/manuscript/sections/${sectionId}/versions/${versionId}/restore`,
      );
      toast.success("Version restored");
      onOpenChange(false);
      onRestored();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to restore the version");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Durable snapshots cut at editing-session boundaries and explicit saves.
            {canRestore ? "" : " Acquire the edit lock to restore."}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-96 space-y-2 overflow-y-auto">
          {versions === null ? (
            <Skeleton className="h-24" />
          ) : versions.length === 0 ? (
            <EmptyState
              icon={History}
              title="No versions yet"
              description="Versions are cut when an editing session ends or someone saves one explicitly."
            />
          ) : (
            versions.map((v) => (
              <div key={v.id} className="rounded-md border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{v.versionNumber}</span>
                    <Badge variant="secondary">{ORIGIN_LABEL[v.origin]}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {v.savedBy.name} · {new Date(v.createdAt).toLocaleString()} · {v.wordCount}{" "}
                      words
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" className="h-7" onClick={() => void preview(v.id)}>
                      Preview
                    </Button>
                    {canRestore && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7"
                        disabled={busyId !== null}
                        onClick={() => void restore(v.id)}
                      >
                        <RotateCcw /> Restore
                      </Button>
                    )}
                  </div>
                </div>
                {v.note && <p className="mt-1 text-xs text-muted-foreground">“{v.note}”</p>}
                {previewText[v.id] && (
                  <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-line rounded bg-muted/50 p-2 text-xs">
                    {previewText[v.id]}
                  </p>
                )}
              </div>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
