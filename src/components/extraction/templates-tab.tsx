"use client";

// Templates tab: template list + version/status lifecycle + field builder for drafts.
// DRAFT → structural edits allowed; PUBLISHED → name/description only + "New version";
// ARCHIVED → read-only history.

import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitBranch,
  ListChecks,
  Pencil,
  Plus,
  Rocket,
  Table2,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EmptyState, Skeleton, Spinner } from "@/components/ui/misc";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { FieldDialog } from "./field-dialog";
import { TemplateStatusBadge } from "./status-badges";
import {
  FIELD_TYPE_LABELS,
  SELECT_FIELD_TYPES,
  fieldOptions,
  type Template,
  type TemplateField,
} from "./types";

export function TemplatesTab({
  projectId,
  templates,
  onChanged,
  canManage,
}: {
  projectId: string;
  templates: Template[] | null;
  onChanged: () => void;
  canManage: boolean;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [createBusy, setCreateBusy] = useState(false);

  // Edit name/description dialog
  const [metaOpen, setMetaOpen] = useState(false);
  const [metaName, setMetaName] = useState("");
  const [metaDesc, setMetaDesc] = useState("");
  const [metaBusy, setMetaBusy] = useState(false);

  // Field builder dialogs
  const [fieldDialogOpen, setFieldDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<TemplateField | null>(null);
  const [deletingField, setDeletingField] = useState<TemplateField | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Lifecycle actions
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishBusy, setPublishBusy] = useState(false);
  const [versionBusy, setVersionBusy] = useState(false);
  const [reorderBusy, setReorderBusy] = useState(false);

  const selected = templates?.find((t) => t.id === selectedId) ?? null;

  // Auto-select the first template once loaded. Never clobber an explicit selection —
  // a just-created template/version is selected before the list reload includes it.
  useEffect(() => {
    if (selectedId !== null) return;
    const first = templates?.[0];
    if (first) setSelectedId(first.id);
  }, [templates, selectedId]);

  const templateBase = `/api/projects/${projectId}/extraction/templates`;

  async function createTemplate(e: React.FormEvent) {
    e.preventDefault();
    setCreateBusy(true);
    try {
      const t = await apiPost<{ id: string }>(templateBase, {
        name: createName.trim(),
        ...(createDesc.trim() !== "" && { description: createDesc.trim() }),
      });
      toast.success("Template created as a draft");
      setCreateOpen(false);
      setCreateName("");
      setCreateDesc("");
      setSelectedId(t.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create template");
    } finally {
      setCreateBusy(false);
    }
  }

  function openMeta() {
    if (!selected) return;
    setMetaName(selected.name);
    setMetaDesc(selected.description ?? "");
    setMetaOpen(true);
  }

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setMetaBusy(true);
    try {
      await apiPatch(`${templateBase}/${selected.id}`, {
        name: metaName.trim(),
        description: metaDesc.trim() === "" ? null : metaDesc.trim(),
      });
      toast.success("Template details updated");
      setMetaOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to update template");
    } finally {
      setMetaBusy(false);
    }
  }

  async function publish() {
    if (!selected) return;
    setPublishBusy(true);
    try {
      await apiPost(`${templateBase}/${selected.id}/publish`);
      toast.success(`Template v${selected.version} published`);
      setPublishOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to publish template");
    } finally {
      setPublishBusy(false);
    }
  }

  async function newVersion() {
    if (!selected) return;
    setVersionBusy(true);
    try {
      const clone = await apiPost<{ id: string; version: number }>(
        `${templateBase}/${selected.id}/new-version`,
      );
      toast.success(`Draft v${clone.version} created — edit its fields, then publish`);
      setSelectedId(clone.id);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create a new version");
    } finally {
      setVersionBusy(false);
    }
  }

  async function deleteField() {
    if (!selected || !deletingField) return;
    setDeleteBusy(true);
    try {
      await apiDelete(`${templateBase}/${selected.id}/fields/${deletingField.id}`);
      toast.success("Field removed");
      setDeletingField(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to remove field");
    } finally {
      setDeleteBusy(false);
    }
  }

  // Renumber every field to its visual index, swapping index and index+dir.
  async function moveField(index: number, dir: -1 | 1) {
    if (!selected) return;
    const next = [...selected.fields];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    setReorderBusy(true);
    try {
      for (let i = 0; i < next.length; i++) {
        const f = next[i];
        if (f && f.order !== i) {
          await apiPatch(`${templateBase}/${selected.id}/fields/${f.id}`, { order: i });
        }
      }
      onChanged();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reorder fields");
    } finally {
      setReorderBusy(false);
    }
  }

  const isDraft = selected?.status === "DRAFT";
  const canBuild = canManage && isDraft;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Templates define the fields extractors fill in for each study. Publishing freezes a
          version.
        </p>
        {canManage && (
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus /> New template
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New extraction template</DialogTitle>
                <DialogDescription>
                  Starts as a draft — add fields, then publish it to begin extracting.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={createTemplate} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="t-name">Name</Label>
                  <Input
                    id="t-name"
                    required
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="Study characteristics"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="t-desc">Description (optional)</Label>
                  <Textarea
                    id="t-desc"
                    value={createDesc}
                    onChange={(e) => setCreateDesc(e.target.value)}
                    rows={3}
                  />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={createBusy}>
                    {createBusy && <Spinner />} Create draft
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {templates === null ? (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : templates.length === 0 ? (
        <EmptyState
          icon={Table2}
          title="No extraction templates yet"
          description="Create a template, add the fields you want extracted from each study, then publish it."
          action={
            canManage ? (
              <Button size="sm" onClick={() => setCreateOpen(true)}>
                <Plus /> New template
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* Template list */}
          <div className="space-y-2">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelectedId(t.id)}
                className={cn(
                  "w-full rounded-lg border bg-card p-3 text-left transition-colors",
                  t.id === selectedId
                    ? "border-ring ring-1 ring-ring"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{t.name}</span>
                  <Badge variant="outline">v{t.version}</Badge>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <TemplateStatusBadge status={t.status} />
                  <span className="text-xs text-muted-foreground">
                    {t.fields.length} {t.fields.length === 1 ? "field" : "fields"}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* Template detail / builder */}
          {selected === null ? (
            <Skeleton className="h-64" />
          ) : (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{selected.name}</CardTitle>
                      <Badge variant="outline">v{selected.version}</Badge>
                      <TemplateStatusBadge status={selected.status} />
                    </div>
                    <CardDescription className="mt-1">
                      {selected.description || "No description."}
                    </CardDescription>
                  </div>
                  {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="outline" size="sm" onClick={openMeta}>
                        <Pencil /> Edit details
                      </Button>
                      {selected.status === "DRAFT" && (
                        <Button size="sm" onClick={() => setPublishOpen(true)}>
                          <Rocket /> Publish
                        </Button>
                      )}
                      {selected.status === "PUBLISHED" && (
                        <Button variant="outline" size="sm" onClick={newVersion} disabled={versionBusy}>
                          {versionBusy ? <Spinner /> : <GitBranch />} New version
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-medium">Fields ({selected.fields.length})</h3>
                  {canBuild && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setEditingField(null);
                        setFieldDialogOpen(true);
                      }}
                    >
                      <Plus /> Add field
                    </Button>
                  )}
                </div>
                {selected.status === "PUBLISHED" && (
                  <p className="text-xs text-muted-foreground">
                    Published — fields are frozen. Create a new version to change the structure.
                  </p>
                )}
                {selected.fields.length === 0 ? (
                  <EmptyState
                    icon={ListChecks}
                    title="No fields yet"
                    description="Add at least one field before publishing this template."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-10">#</TableHead>
                        <TableHead>Field</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="hidden md:table-cell">Section</TableHead>
                        <TableHead>Required</TableHead>
                        <TableHead className="hidden lg:table-cell">Options</TableHead>
                        {canBuild && <TableHead className="w-36 text-right">Actions</TableHead>}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {selected.fields.map((f, i) => {
                        const opts = fieldOptions(f.options);
                        return (
                          <TableRow key={f.id}>
                            <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                            <TableCell>
                              <p className="font-medium">{f.label}</p>
                              <p className="font-mono text-xs text-muted-foreground">{f.key}</p>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {FIELD_TYPE_LABELS[f.type]}
                            </TableCell>
                            <TableCell className="hidden text-muted-foreground md:table-cell">
                              {f.section || "—"}
                            </TableCell>
                            <TableCell>
                              {f.required ? (
                                <Check className="h-4 w-4 text-include" aria-label="Required" />
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell className="hidden max-w-56 lg:table-cell">
                              {SELECT_FIELD_TYPES.includes(f.type) ? (
                                <span className="line-clamp-1 text-xs text-muted-foreground">
                                  {opts.map((o) => o.label).join(", ") || "—"}
                                </span>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            {canBuild && (
                              <TableCell>
                                <div className="flex items-center justify-end gap-0.5">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    aria-label="Move up"
                                    disabled={reorderBusy || i === 0}
                                    onClick={() => moveField(i, -1)}
                                  >
                                    <ArrowUp />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    aria-label="Move down"
                                    disabled={reorderBusy || i === selected.fields.length - 1}
                                    onClick={() => moveField(i, 1)}
                                  >
                                    <ArrowDown />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7"
                                    aria-label="Edit field"
                                    onClick={() => {
                                      setEditingField(f);
                                      setFieldDialogOpen(true);
                                    }}
                                  >
                                    <Pencil />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 text-exclude"
                                    aria-label="Delete field"
                                    onClick={() => setDeletingField(f)}
                                  >
                                    <Trash2 />
                                  </Button>
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Field add/edit dialog */}
      {selected && (
        <FieldDialog
          projectId={projectId}
          templateId={selected.id}
          field={editingField}
          defaultOrder={selected.fields.length}
          open={fieldDialogOpen}
          onOpenChange={setFieldDialogOpen}
          onSaved={onChanged}
        />
      )}

      {/* Delete field confirm */}
      <Dialog open={deletingField !== null} onOpenChange={(o) => !o && setDeletingField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove field?</DialogTitle>
            <DialogDescription>
              {deletingField
                ? `"${deletingField.label}" will be removed from this draft. Draft templates have no extraction forms, so no data is lost.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingField(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={deleteField} disabled={deleteBusy}>
              {deleteBusy && <Spinner />} Remove field
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Publish confirm */}
      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish template?</DialogTitle>
            <DialogDescription>
              Publishing freezes the fields of v{selected?.version}. Extraction forms will
              reference this exact version; structural changes will require a new version.
              {selected?.sourceTemplateId
                ? " The previous published version will be archived."
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              Cancel
            </Button>
            <Button onClick={publish} disabled={publishBusy}>
              {publishBusy && <Spinner />} <Rocket /> Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit name/description */}
      <Dialog open={metaOpen} onOpenChange={setMetaOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit template details</DialogTitle>
            <DialogDescription>
              Name and description stay editable after publishing; fields do not.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={saveMeta} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tm-name">Name</Label>
              <Input
                id="tm-name"
                required
                value={metaName}
                onChange={(e) => setMetaName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tm-desc">Description</Label>
              <Textarea
                id="tm-desc"
                value={metaDesc}
                onChange={(e) => setMetaDesc(e.target.value)}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button type="submit" disabled={metaBusy}>
                {metaBusy && <Spinner />} Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
