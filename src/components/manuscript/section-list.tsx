"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Lock, MessageSquare, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPost, apiPut, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  initials,
  SECTION_STATUS_VARIANT,
  type SectionKind,
  type SectionSummary,
} from "./types";

const KIND_OPTIONS: { value: SectionKind; label: string }[] = [
  { value: "CUSTOM", label: "Custom" },
  { value: "INTRODUCTION", label: "Introduction" },
  { value: "METHODS", label: "Methods" },
  { value: "RESULTS", label: "Results" },
  { value: "DISCUSSION", label: "Discussion" },
];

export function SectionList({
  projectId,
  sections,
  selectedId,
  onSelect,
  canManage,
  onChanged,
}: {
  projectId: string;
  sections: SectionSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<SectionKind>("CUSTOM");
  const [busy, setBusy] = useState(false);

  async function addSection(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/manuscript/sections`, {
        title: title.trim(),
        kind,
      });
      toast.success("Section added");
      setAddOpen(false);
      setTitle("");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add the section");
    } finally {
      setBusy(false);
    }
  }

  async function move(section: SectionSummary, delta: -1 | 1) {
    const ids = sections.map((s) => s.id);
    const index = ids.indexOf(section.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    try {
      await apiPut(`/api/projects/${projectId}/manuscript/sections/reorder`, { orderedIds: ids });
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reorder");
    }
  }

  async function remove(section: SectionSummary) {
    if (!window.confirm(`Delete the “${section.title}” section and its history?`)) return;
    try {
      await apiDelete(`/api/projects/${projectId}/manuscript/sections/${section.id}`);
      toast.success("Section deleted");
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to delete the section");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between pb-2">
        <p className="text-sm font-medium">Sections</p>
        {canManage && (
          <Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => setAddOpen(true)}>
            <Plus /> Add
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {sections.map((section, index) => (
          <div
            key={section.id}
            className={cn(
              "group rounded-md border px-2.5 py-2 transition-colors",
              selectedId === section.id
                ? "border-transparent bg-accent"
                : "border-transparent hover:bg-muted",
            )}
          >
            <button type="button" className="w-full text-left" onClick={() => onSelect(section.id)}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">{section.title}</span>
                <Badge variant={SECTION_STATUS_VARIANT[section.status]} className="shrink-0">
                  {section.status === "IN_REVIEW" ? "review" : section.status.toLowerCase()}
                </Badge>
              </span>
              <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <span>{section.wordCount} words</span>
                {section.openCommentCount > 0 && (
                  <span className="inline-flex items-center gap-0.5">
                    <MessageSquare className="h-3 w-3" /> {section.openCommentCount}
                  </span>
                )}
                {section.assignee && (
                  <span
                    className="inline-flex h-4.5 items-center rounded-full bg-secondary px-1.5 font-medium text-secondary-foreground"
                    title={`Assigned to ${section.assignee.name}`}
                  >
                    {initials(section.assignee.name)}
                  </span>
                )}
                {section.lock && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5",
                      section.lock.stale ? "opacity-60" : "text-maybe",
                    )}
                    title={
                      section.lock.stale
                        ? `${section.lock.name}'s session looks idle`
                        : `${section.lock.name} is editing`
                    }
                  >
                    <Lock className="h-3 w-3" />
                    {section.lock.name.split(" ")[0]}
                  </span>
                )}
              </span>
            </button>
            {canManage && (
              <div className="mt-1 hidden items-center gap-0.5 group-hover:flex">
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-background"
                  disabled={index === 0}
                  onClick={() => void move(section, -1)}
                  title="Move up"
                >
                  <ArrowUp className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-background"
                  disabled={index === sections.length - 1}
                  onClick={() => void move(section, 1)}
                  title="Move down"
                >
                  <ArrowDown className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                  onClick={() => void remove(section)}
                  title="Delete section"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add section</DialogTitle>
            <DialogDescription>Appends a new section to the manuscript.</DialogDescription>
          </DialogHeader>
          <form onSubmit={addSection} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="section-title">Title</Label>
              <Input
                id="section-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Limitations"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="section-kind">Kind</Label>
              <Select
                id="section-kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as SectionKind)}
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
            <DialogFooter>
              <Button type="submit" disabled={busy || !title.trim()}>
                <Plus /> Add section
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
