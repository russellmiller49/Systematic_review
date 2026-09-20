"use client";

import { useEffect, useRef } from "react";
import type { DecisionValue, ExclusionReasonOption } from "./types";

export function useScreeningShortcuts(options: {
  blocked: boolean;
  canDecide: boolean;
  reasons: ExclusionReasonOption[] | null;
  onDecision: (value: DecisionValue) => void;
  onQuickExclude: (reason: ExclusionReasonOption) => void;
  onToggleNote: () => void;
  onNavigate: (delta: -1 | 1) => void;
  onHelp: () => void;
}) {
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const current = latest.current;
      // Any modal (including quota administration) owns its keyboard events.
      if (
        current.blocked ||
        document.querySelector('[role="dialog"]') ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
          target.isContentEditable)
      )
        return;
      const key = event.key.toLowerCase();
      if (/^[1-9]$/.test(key) && current.canDecide) {
        const reason = current.reasons?.[Number(key) - 1];
        if (!reason) return;
        current.onQuickExclude(reason);
      } else if (["i", "e", "m"].includes(key) && current.canDecide) {
        current.onDecision(
          key === "i" ? "INCLUDE" : key === "e" ? "EXCLUDE" : "MAYBE",
        );
      } else if (key === "n" && current.canDecide) current.onToggleNote();
      else if (key === "j" || key === "arrowright") current.onNavigate(1);
      else if (key === "k" || key === "arrowleft") current.onNavigate(-1);
      else if (key === "?") current.onHelp();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
