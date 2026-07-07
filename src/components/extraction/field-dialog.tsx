"use client";

// Add / edit a field on a DRAFT template. Mirrors the API's field schema exactly:
// key (machine name), label, type, section?, helpText?, required, options (select types
// only), order.

import { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiPatch, apiPost, ApiError } from "@/lib/api";
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
import { Spinner } from "@/components/ui/misc";
import { Textarea } from "@/components/ui/textarea";
import {
  FIELD_TYPE_LABELS,
  SELECT_FIELD_TYPES,
  fieldOptions,
  type FieldOption,
  type FieldType,
  type TemplateField,
} from "./types";

const FIELD_KEY_RE = /^[a-z][a-z0-9_]*$/;

const FIELD_TYPES: FieldType[] = [
  "TEXT",
  "TEXTAREA",
  "NUMBER",
  "DATE",
  "SINGLE_SELECT",
  "MULTI_SELECT",
  "BOOLEAN",
];

export function FieldDialog({
  projectId,
  templateId,
  field,
  defaultOrder,
  open,
  onOpenChange,
  onSaved,
}: {
  projectId: string;
  templateId: string;
  field: TemplateField | null; // null = create
  defaultOrder: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const isEdit = field !== null;
  const [key, setKey] = useState("");
  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("TEXT");
  const [section, setSection] = useState("");
  const [helpText, setHelpText] = useState("");
  const [required, setRequired] = useState(false);
  const [order, setOrder] = useState("0");
  const [options, setOptions] = useState<FieldOption[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKey(field?.key ?? "");
    setLabel(field?.label ?? "");
    setType(field?.type ?? "TEXT");
    setSection(field?.section ?? "");
    setHelpText(field?.helpText ?? "");
    setRequired(field?.required ?? false);
    setOrder(String(field?.order ?? defaultOrder));
    setOptions(field ? fieldOptions(field.options) : []);
  }, [open, field, defaultOrder]);

  const isSelect = SELECT_FIELD_TYPES.includes(type);

  function updateOption(index: number, patch: Partial<FieldOption>) {
    setOptions((prev) => prev.map((o, i) => (i === index ? { ...o, ...patch } : o)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleanKey = key.trim();
    if (!FIELD_KEY_RE.test(cleanKey)) {
      toast.error("Key must start with a lowercase letter and use only a-z, 0-9 and _");
      return;
    }
    const orderNum = Number(order);
    if (!Number.isInteger(orderNum) || orderNum < 0) {
      toast.error("Order must be a whole number (0 or more)");
      return;
    }
    let cleanOptions: FieldOption[] | undefined;
    if (isSelect) {
      cleanOptions = options
        .map((o) => ({ value: o.value.trim(), label: o.label.trim() || o.value.trim() }))
        .filter((o) => o.value.length > 0);
      if (cleanOptions.length === 0) {
        toast.error("Select fields need at least one option");
        return;
      }
      if (new Set(cleanOptions.map((o) => o.value)).size !== cleanOptions.length) {
        toast.error("Option values must be unique");
        return;
      }
    }
    setBusy(true);
    try {
      const base = `/api/projects/${projectId}/extraction/templates/${templateId}/fields`;
      if (isEdit && field) {
        await apiPatch(`${base}/${field.id}`, {
          key: cleanKey,
          label: label.trim(),
          type,
          section: section.trim() === "" ? null : section.trim(),
          helpText: helpText.trim() === "" ? null : helpText.trim(),
          required,
          order: orderNum,
          options: isSelect ? cleanOptions : null,
        });
        toast.success("Field updated");
      } else {
        await apiPost(base, {
          key: cleanKey,
          label: label.trim(),
          type,
          ...(section.trim() !== "" && { section: section.trim() }),
          ...(helpText.trim() !== "" && { helpText: helpText.trim() }),
          required,
          order: orderNum,
          ...(isSelect && { options: cleanOptions }),
        });
        toast.success("Field added");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save field");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit field" : "Add field"}</DialogTitle>
          <DialogDescription>
            Fields are frozen once the template is published — edit freely while it is a draft.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fd-label">Label</Label>
              <Input
                id="fd-label"
                required
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Sample size"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fd-key">Key</Label>
              <Input
                id="fd-key"
                required
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sample_size"
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">
                Machine name — lowercase letter first, then a-z, 0-9, _
              </p>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="fd-type">Type</Label>
              <Select
                id="fd-type"
                value={type}
                onChange={(e) => setType(e.target.value as FieldType)}
              >
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABELS[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fd-section">Section (optional)</Label>
              <Input
                id="fd-section"
                value={section}
                onChange={(e) => setSection(e.target.value)}
                placeholder="Population"
              />
            </div>
          </div>
          {isSelect && (
            <div className="space-y-1.5">
              <Label>Options</Label>
              <div className="space-y-2">
                {options.map((o, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={o.value}
                      onChange={(e) => updateOption(i, { value: e.target.value })}
                      placeholder="value"
                      className="font-mono"
                    />
                    <Input
                      value={o.label}
                      onChange={(e) => updateOption(i, { label: e.target.value })}
                      placeholder="Label"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove option"
                      onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOptions((prev) => [...prev, { value: "", label: "" }])}
                >
                  <Plus /> Add option
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Value is stored in the data; label is what extractors see.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="fd-help">Help text (optional)</Label>
            <Textarea
              id="fd-help"
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              placeholder="Guidance shown to extractors under the field."
              rows={2}
            />
          </div>
          <div className="flex flex-wrap items-end gap-6">
            <div className="space-y-1.5">
              <Label htmlFor="fd-order">Order</Label>
              <Input
                id="fd-order"
                type="number"
                min={0}
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                className="w-24"
              />
            </div>
            <label htmlFor="fd-required" className="flex cursor-pointer items-center gap-2 pb-2 text-sm">
              <input
                id="fd-required"
                type="checkbox"
                className="h-4 w-4 rounded border-input accent-primary"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required to complete a form
            </label>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={busy}>
              {busy && <Spinner />} {isEdit ? "Save field" : "Add field"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
