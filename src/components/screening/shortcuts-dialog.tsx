"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StageType } from "./types";

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({
  open,
  onOpenChange,
  stageType,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stageType: StageType;
}) {
  const rows: { keys: string[]; action: string }[] = [
    { keys: ["i"], action: "Include" },
    {
      keys: ["e"],
      action:
        stageType === "FULL_TEXT"
          ? "Exclude — opens the exclusion-reason dialog"
          : "Exclude",
    },
    { keys: ["m"], action: "Maybe" },
    { keys: ["n"], action: "Toggle the note field" },
    { keys: ["j", "→"], action: "Skip to the next citation" },
    { keys: ["?"], action: "Show this help" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Shortcuts are active whenever you are not typing in a field.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.action} className="flex items-center justify-between gap-4 text-sm">
              <span>{row.action}</span>
              <span className="flex items-center gap-1">
                {row.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
