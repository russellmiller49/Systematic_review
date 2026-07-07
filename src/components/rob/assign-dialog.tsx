"use client";

import { useMemo, useState } from "react";
import { Users } from "lucide-react";
import { toast } from "sonner";
import { apiPost, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/misc";
import { rolesCanAssess, type MemberRow, type RobTool, type StudyRow } from "./types";

function toggle(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Bulk assignment dialog: studies × assessors for one published tool. */
export function AssignDialog({
  projectId,
  tools,
  studies,
  members,
  onCreated,
}: {
  projectId: string;
  tools: RobTool[];
  studies: StudyRow[];
  members: MemberRow[];
  onCreated: () => void;
}) {
  const publishedTools = useMemo(() => tools.filter((t) => t.status === "PUBLISHED"), [tools]);
  const assessors = useMemo(
    () => members.filter((m) => m.status === "ACTIVE" && rolesCanAssess(m.roles)),
    [members],
  );

  const [open, setOpen] = useState(false);
  const [toolId, setToolId] = useState("");
  const [studyIds, setStudyIds] = useState<Set<string>>(new Set());
  const [assessorIds, setAssessorIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const effectiveToolId = toolId || (publishedTools[0]?.id ?? "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!effectiveToolId || studyIds.size === 0 || assessorIds.size === 0) {
      toast.error("Pick a tool, at least one study, and at least one assessor");
      return;
    }
    setBusy(true);
    try {
      const result = await apiPost<{ created: { id: string }[]; skipped: number }>(
        `/api/projects/${projectId}/rob/assignments`,
        {
          toolId: effectiveToolId,
          studyIds: [...studyIds],
          assessorIds: [...assessorIds],
        },
      );
      toast.success(
        `${result.created.length} assignment${result.created.length === 1 ? "" : "s"} created` +
          (result.skipped > 0 ? ` · ${result.skipped} already existed` : ""),
      );
      setOpen(false);
      setStudyIds(new Set());
      setAssessorIds(new Set());
      onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create assignments");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Users /> Assign assessors
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Assign risk-of-bias assessments</DialogTitle>
          <DialogDescription>
            Every selected assessor is assigned every selected study. Existing assignments are
            skipped.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="assign-tool">Tool (published)</Label>
            <Select
              id="assign-tool"
              value={effectiveToolId}
              onChange={(e) => setToolId(e.target.value)}
              disabled={publishedTools.length === 0}
            >
              {publishedTools.length === 0 && <option value="">No published tools</option>}
              {publishedTools.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isBuiltin ? " (built-in)" : ""}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              Studies <span className="font-normal text-muted-foreground">({studyIds.size} selected)</span>
            </Label>
            {studies.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                No studies in this project yet — group included reports into studies first.
              </p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {studies.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={studyIds.has(s.id)}
                      onChange={() => setStudyIds((prev) => toggle(prev, s.id))}
                    />
                    <span className="truncate">{s.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>
              Assessors{" "}
              <span className="font-normal text-muted-foreground">({assessorIds.size} selected)</span>
            </Label>
            {assessors.length === 0 ? (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
                No active members with assessment rights.
              </p>
            ) : (
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {assessors.map((m) => (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-muted">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-primary"
                      checked={assessorIds.has(m.user.id)}
                      onChange={() => setAssessorIds((prev) => toggle(prev, m.user.id))}
                    />
                    <span className="truncate">{m.user.name}</span>
                    <span className="truncate text-xs text-muted-foreground">{m.user.email}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button type="submit" disabled={busy || publishedTools.length === 0}>
              {busy && <Spinner />} Create assignments
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
