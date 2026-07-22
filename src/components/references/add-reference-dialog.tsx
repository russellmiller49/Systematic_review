"use client";

import { useEffect, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiPost, apiPatch, ApiError } from "@/lib/api";
import { Alert, Spinner } from "@/components/ui/misc";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cslYear, formatCslAuthors, type CslItemView, type LookupResponse, type ReferenceView } from "./types";

const CSL_TYPES: { value: string; label: string }[] = [
  { value: "article-journal", label: "Journal article" },
  { value: "book", label: "Book" },
  { value: "chapter", label: "Book chapter" },
  { value: "paper-conference", label: "Conference paper" },
  { value: "report", label: "Report" },
  { value: "webpage", label: "Web page" },
];

interface ManualAuthor {
  family: string;
  given: string;
}

// Add/edit dialog. Add mode offers DOI / PMID lookup, RIS/BibTeX paste-import, and a
// manual form; edit mode opens straight into the manual form pre-filled from the entry.
export function AddReferenceDialog({
  projectId,
  open,
  onOpenChange,
  onSaved,
  editing,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
  editing: ReferenceView | null;
}) {
  const [tab, setTab] = useState<string>("doi");
  const [busy, setBusy] = useState(false);

  // Lookup tabs
  const [lookupValue, setLookupValue] = useState("");
  const [preview, setPreview] = useState<LookupResponse | null>(null);

  // File tab
  const [importFormat, setImportFormat] = useState<"RIS" | "BIBTEX">("RIS");
  const [importContent, setImportContent] = useState("");

  // Manual tab
  const [type, setType] = useState("article-journal");
  const [title, setTitle] = useState("");
  const [authors, setAuthors] = useState<ManualAuthor[]>([{ family: "", given: "" }]);
  const [year, setYear] = useState("");
  const [journal, setJournal] = useState("");
  const [volume, setVolume] = useState("");
  const [issue, setIssue] = useState("");
  const [pages, setPages] = useState("");
  const [doi, setDoi] = useState("");
  const [pmid, setPmid] = useState("");
  const [url, setUrl] = useState("");
  const [tags, setTags] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setPreview(null);
    setLookupValue("");
    setImportContent("");
    if (editing) {
      setTab("manual");
      const csl = editing.csl;
      setType(csl.type ?? "article-journal");
      setTitle(csl.title ?? "");
      setAuthors(
        csl.author && csl.author.length > 0
          ? csl.author.map((a) => ({ family: a.family ?? a.literal ?? "", given: a.given ?? "" }))
          : [{ family: "", given: "" }],
      );
      setYear(cslYear(csl) !== null ? String(cslYear(csl)) : "");
      setJournal(csl["container-title"] ?? "");
      setVolume(csl.volume ?? "");
      setIssue(csl.issue ?? "");
      setPages(csl.page ?? "");
      setDoi(csl.DOI ?? "");
      setPmid(csl.PMID ?? "");
      setUrl(csl.URL ?? "");
      setTags(editing.tags.join(", "));
      setNotes(editing.notes ?? "");
    } else {
      setTab("doi");
      setType("article-journal");
      setTitle("");
      setAuthors([{ family: "", given: "" }]);
      setYear("");
      setJournal("");
      setVolume("");
      setIssue("");
      setPages("");
      setDoi("");
      setPmid("");
      setUrl("");
      setTags("");
      setNotes("");
    }
  }, [open, editing]);

  async function runLookup(kind: "doi" | "pmid") {
    if (!lookupValue.trim()) return;
    setBusy(true);
    setPreview(null);
    try {
      const res = await apiPost<LookupResponse>(`/api/projects/${projectId}/references/lookup`, {
        kind,
        value: lookupValue.trim(),
      });
      setPreview(res);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function addFromPreview() {
    if (!preview) return;
    setBusy(true);
    try {
      await apiPost(`/api/projects/${projectId}/references`, { csl: preview.csl });
      toast.success("Reference added");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to add the reference");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    if (!importContent.trim()) return;
    setBusy(true);
    try {
      const res = await apiPost<{ added: number; skipped: number; parseErrors: number }>(
        `/api/projects/${projectId}/references/import`,
        { format: importFormat, content: importContent },
      );
      toast.success(
        `Imported ${res.added} reference${res.added === 1 ? "" : "s"}` +
          (res.skipped > 0 ? ` · ${res.skipped} duplicate${res.skipped === 1 ? "" : "s"} skipped` : "") +
          (res.parseErrors > 0 ? ` · ${res.parseErrors} unparseable` : ""),
      );
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  function buildManualCsl(): CslItemView | null {
    if (!title.trim()) {
      toast.error("A title is required");
      return null;
    }
    const author = authors
      .map((a) => ({ family: a.family.trim(), given: a.given.trim() }))
      .filter((a) => a.family)
      .map((a) => (a.given ? { family: a.family, given: a.given } : { family: a.family }));
    const yearNum = year.trim() ? Number(year.trim()) : null;
    const csl: CslItemView = { type, title: title.trim() };
    if (author.length > 0) csl.author = author;
    if (yearNum && Number.isFinite(yearNum)) csl.issued = { "date-parts": [[yearNum]] };
    if (journal.trim()) csl["container-title"] = journal.trim();
    if (volume.trim()) csl.volume = volume.trim();
    if (issue.trim()) csl.issue = issue.trim();
    if (pages.trim()) csl.page = pages.trim();
    if (doi.trim()) csl.DOI = doi.trim();
    if (pmid.trim()) csl.PMID = pmid.trim();
    if (url.trim()) csl.URL = url.trim();
    return csl;
  }

  async function saveManual() {
    const csl = buildManualCsl();
    if (!csl) return;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    setBusy(true);
    try {
      if (editing) {
        await apiPatch(`/api/projects/${projectId}/references/${editing.id}`, {
          csl,
          tags: tagList,
          notes: notes.trim() || null,
        });
        toast.success("Reference updated");
      } else {
        await apiPost(`/api/projects/${projectId}/references`, {
          csl,
          tags: tagList.length > 0 ? tagList : undefined,
          notes: notes.trim() || undefined,
        });
        toast.success("Reference added");
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save the reference");
    } finally {
      setBusy(false);
    }
  }

  const lookupTab = (kind: "doi" | "pmid") => (
    <div className="space-y-3">
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={`lookup-${kind}`}>{kind === "doi" ? "DOI" : "PMID"}</Label>
          <Input
            id={`lookup-${kind}`}
            placeholder={kind === "doi" ? "10.1136/bmj.n71" : "33782057"}
            value={lookupValue}
            onChange={(e) => {
              setLookupValue(e.target.value);
              setPreview(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runLookup(kind);
              }
            }}
          />
        </div>
        <Button onClick={() => void runLookup(kind)} disabled={busy || !lookupValue.trim()}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <Search />} Look up
        </Button>
      </div>
      {preview && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-muted/40 p-3">
            <p className="text-sm font-medium leading-snug">{preview.csl.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {formatCslAuthors(preview.csl.author)}
              {preview.csl["container-title"] ? ` · ${preview.csl["container-title"]}` : ""}
              {cslYear(preview.csl) !== null ? ` · ${cslYear(preview.csl)}` : ""}
            </p>
            {preview.csl.DOI && (
              <p className="mt-1 text-xs text-muted-foreground">DOI {preview.csl.DOI}</p>
            )}
          </div>
          {preview.duplicateOfId ? (
            <Alert variant="warning">This reference is already in the library.</Alert>
          ) : (
            <Button onClick={() => void addFromPreview()} disabled={busy}>
              <Plus /> Add to library
            </Button>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit reference" : "Add reference"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Update the bibliographic details, tags, or notes."
              : "Look up by identifier, paste an RIS/BibTeX export, or enter details manually."}
          </DialogDescription>
        </DialogHeader>

        {editing ? (
          renderManualForm()
        ) : (
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              <TabsTrigger value="doi">DOI</TabsTrigger>
              <TabsTrigger value="pmid">PMID</TabsTrigger>
              <TabsTrigger value="file">RIS / BibTeX</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>
            <TabsContent value="doi" className="pt-3">
              {lookupTab("doi")}
            </TabsContent>
            <TabsContent value="pmid" className="pt-3">
              {lookupTab("pmid")}
            </TabsContent>
            <TabsContent value="file" className="space-y-3 pt-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="import-format" className="shrink-0">
                  Format
                </Label>
                <Select
                  id="import-format"
                  className="w-36"
                  value={importFormat}
                  onChange={(e) => setImportFormat(e.target.value as "RIS" | "BIBTEX")}
                >
                  <option value="RIS">RIS</option>
                  <option value="BIBTEX">BibTeX</option>
                </Select>
              </div>
              <Textarea
                rows={10}
                placeholder={
                  importFormat === "RIS"
                    ? "TY  - JOUR\nTI  - …\nER  - "
                    : "@article{key,\n  title = {…},\n}"
                }
                value={importContent}
                onChange={(e) => setImportContent(e.target.value)}
              />
              <DialogFooter>
                <Button onClick={() => void runImport()} disabled={busy || !importContent.trim()}>
                  {busy ? <Spinner className="h-3.5 w-3.5" /> : <Plus />} Import references
                </Button>
              </DialogFooter>
            </TabsContent>
            <TabsContent value="manual" className="pt-3">
              {renderManualForm()}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );

  // Plain render function (NOT a nested component) — a nested component type would be
  // recreated on every parent render, remounting the form and dropping input focus.
  function renderManualForm() {
    return (
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void saveManual();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div className="space-y-1.5">
            <Label htmlFor="ref-type">Type</Label>
            <Select id="ref-type" value={type} onChange={(e) => setType(e.target.value)}>
              {CSL_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-title">Title</Label>
            <Input id="ref-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Authors</Label>
          {authors.map((author, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="Family name"
                value={author.family}
                onChange={(e) =>
                  setAuthors((prev) =>
                    prev.map((a, j) => (j === i ? { ...a, family: e.target.value } : a)),
                  )
                }
              />
              <Input
                placeholder="Given name(s)"
                value={author.given}
                onChange={(e) =>
                  setAuthors((prev) =>
                    prev.map((a, j) => (j === i ? { ...a, given: e.target.value } : a)),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                disabled={authors.length === 1}
                onClick={() => setAuthors((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 />
                <span className="sr-only">Remove author</span>
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAuthors((prev) => [...prev, { family: "", given: "" }])}
          >
            <Plus /> Add author
          </Button>
        </div>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="space-y-1.5">
            <Label htmlFor="ref-year">Year</Label>
            <Input id="ref-year" value={year} onChange={(e) => setYear(e.target.value)} />
          </div>
          <div className="space-y-1.5 sm:col-span-3">
            <Label htmlFor="ref-journal">Journal / container</Label>
            <Input id="ref-journal" value={journal} onChange={(e) => setJournal(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="ref-volume">Volume</Label>
            <Input id="ref-volume" value={volume} onChange={(e) => setVolume(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-issue">Issue</Label>
            <Input id="ref-issue" value={issue} onChange={(e) => setIssue(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-pages">Pages</Label>
            <Input id="ref-pages" value={pages} onChange={(e) => setPages(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="ref-doi">DOI</Label>
            <Input id="ref-doi" value={doi} onChange={(e) => setDoi(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-pmid">PMID</Label>
            <Input id="ref-pmid" value={pmid} onChange={(e) => setPmid(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-url">URL</Label>
            <Input id="ref-url" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ref-tags">Tags (comma-separated)</Label>
            <Input
              id="ref-tags"
              placeholder="methods, background"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ref-notes">Notes</Label>
            <Input id="ref-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner className="h-3.5 w-3.5" /> : <Plus />}
            {editing ? "Save changes" : "Add reference"}
          </Button>
        </DialogFooter>
      </form>
    );
  }
}
