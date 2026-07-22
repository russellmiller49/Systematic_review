"use client";

import { useEffect, useMemo, useState } from "react";
import { BookMarked, Plus } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, Skeleton } from "@/components/ui/misc";

interface PickerReference {
  id: string;
  title: string;
  firstAuthor: string | null;
  year: number | null;
}

// Multi-select picker over the project reference library; inserts one citation node
// carrying all selected ids (rendered grouped, e.g. [1, 3]).
export function CitationPicker({
  projectId,
  open,
  onOpenChange,
  onInsert,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (referenceIds: string[]) => void;
}) {
  const [references, setReferences] = useState<PickerReference[] | null>(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSearch("");
    api<PickerReference[]>(`/api/projects/${projectId}/references`)
      .then(setReferences)
      .catch((err) => {
        setReferences([]);
        toast.error(err instanceof ApiError ? err.message : "Failed to load the reference library");
      });
  }, [open, projectId]);

  const visible = useMemo(() => {
    if (!references) return null;
    const needle = search.trim().toLowerCase();
    if (!needle) return references;
    return references.filter(
      (r) =>
        r.title.toLowerCase().includes(needle) ||
        (r.firstAuthor ?? "").toLowerCase().includes(needle),
    );
  }, [references, search]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Insert citation</DialogTitle>
          <DialogDescription>
            Pick one or more references from the project library. Manage the library on the
            References page.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search title or author…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {visible === null ? (
            <Skeleton className="h-24" />
          ) : visible.length === 0 ? (
            <EmptyState
              icon={BookMarked}
              title="No references found"
              description="Add references on the References page first."
            />
          ) : (
            visible.map((ref) => (
              <label
                key={ref.id}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border px-2.5 py-2 text-sm hover:bg-muted"
              >
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 accent-primary"
                  checked={selected.has(ref.id)}
                  onChange={() => toggle(ref.id)}
                />
                <span>
                  <span className="font-medium leading-snug">{ref.title}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[ref.firstAuthor, ref.year].filter(Boolean).join(", ") || "—"}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button
            disabled={selected.size === 0}
            onClick={() => {
              onInsert([...selected]);
              onOpenChange(false);
            }}
          >
            <Plus /> Insert {selected.size > 0 ? `(${selected.size})` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
