"use client";

// Typed value editor for a single extraction field. Controlled from the outside via
// `value` + `onCommit`:
//   - TEXT / TEXTAREA / NUMBER keep a local text draft and commit on blur
//     (or per keystroke when `commitOnChange` is set — used inside dialogs).
//   - DATE / BOOLEAN / SINGLE_SELECT / MULTI_SELECT commit on change.
// Commits mirror the API's typed-value contract (src/server/services/extraction/validation.ts):
// string / finite number / "yyyy-mm-dd" / boolean / option value / non-empty option array,
// with `null` meaning "clear the value".

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { fieldOptions, type FieldType } from "./types";

export interface EditorField {
  id: string;
  key: string;
  type: FieldType;
  options?: unknown;
}

function textDraft(type: FieldType, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (type === "NUMBER") return typeof value === "number" ? String(value) : "";
  return typeof value === "string" ? value : "";
}

export function FieldValueEditor({
  field,
  value,
  onCommit,
  disabled = false,
  commitOnChange = false,
  idPrefix = "fv",
}: {
  field: EditorField;
  value: unknown;
  onCommit: (value: unknown) => void;
  disabled?: boolean;
  commitOnChange?: boolean;
  idPrefix?: string;
}) {
  const inputId = `${idPrefix}-${field.id}`;
  const [draft, setDraft] = useState(() => textDraft(field.type, value));
  const [numberError, setNumberError] = useState(false);
  const focusedRef = useRef(false);

  // Re-seed the draft when the committed value changes from the outside — but never while
  // the user is typing (an in-flight save resolving must not stomp their edits).
  useEffect(() => {
    if (focusedRef.current) return;
    setDraft(textDraft(field.type, value));
    setNumberError(false);
  }, [field.id, field.type, value]);

  function commitText(next: string) {
    if (field.type === "NUMBER") {
      if (next.trim() === "") {
        setNumberError(false);
        onCommit(null);
        return;
      }
      const n = Number(next);
      if (!Number.isFinite(n)) {
        setNumberError(true);
        return;
      }
      setNumberError(false);
      onCommit(n);
    } else {
      onCommit(next === "" ? null : next);
    }
  }

  switch (field.type) {
    case "TEXT":
      return (
        <Input
          id={inputId}
          value={draft}
          disabled={disabled}
          placeholder="Not recorded"
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (commitOnChange) commitText(e.target.value);
          }}
          onBlur={() => {
            focusedRef.current = false;
            if (!commitOnChange) commitText(draft);
          }}
        />
      );
    case "TEXTAREA":
      return (
        <Textarea
          id={inputId}
          value={draft}
          disabled={disabled}
          placeholder="Not recorded"
          rows={3}
          onFocus={() => {
            focusedRef.current = true;
          }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (commitOnChange) commitText(e.target.value);
          }}
          onBlur={() => {
            focusedRef.current = false;
            if (!commitOnChange) commitText(draft);
          }}
        />
      );
    case "NUMBER":
      return (
        <div className="space-y-1">
          <Input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={draft}
            disabled={disabled}
            placeholder="Not recorded"
            onFocus={() => {
              focusedRef.current = true;
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              if (commitOnChange) commitText(e.target.value);
            }}
            onBlur={() => {
              focusedRef.current = false;
              if (!commitOnChange) commitText(draft);
            }}
          />
          {numberError && <p className="text-xs text-exclude">Enter a valid number.</p>}
        </div>
      );
    case "DATE":
      return (
        <Input
          id={inputId}
          type="date"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
        />
      );
    case "BOOLEAN":
      return (
        <label htmlFor={inputId} className="flex w-fit cursor-pointer items-center gap-2 text-sm">
          <input
            id={inputId}
            type="checkbox"
            className="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onCommit(e.target.checked)}
          />
          <span className="text-muted-foreground">
            {value === true ? "Yes" : value === false ? "No" : "Not recorded"}
          </span>
        </label>
      );
    case "SINGLE_SELECT": {
      const opts = fieldOptions(field.options);
      return (
        <Select
          id={inputId}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value === "" ? null : e.target.value)}
        >
          <option value="">— not recorded —</option>
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
    }
    case "MULTI_SELECT": {
      const opts = fieldOptions(field.options);
      const selected = Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string")
        : [];
      return (
        <div className="flex flex-col gap-1.5">
          {opts.length === 0 && (
            <p className="text-xs text-muted-foreground">No options defined for this field.</p>
          )}
          {opts.map((o) => {
            const checked = selected.includes(o.value);
            return (
              <label key={o.value} className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-input accent-primary disabled:cursor-not-allowed"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    const next = checked
                      ? selected.filter((v) => v !== o.value)
                      : [...selected, o.value];
                    onCommit(next.length > 0 ? next : null);
                  }}
                />
                {o.label}
              </label>
            );
          })}
        </div>
      );
    }
  }
}
