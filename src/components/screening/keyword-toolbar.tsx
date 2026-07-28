"use client";

import { useState } from "react";
import { Highlighter, Plus, Settings2, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { apiDelete, apiPatch, apiPost, ApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/misc";
import {
  UNMATCHED_KEYWORD_GROUP,
  type ScreeningKeyword,
  type ScreeningKeywordCategory,
} from "./types";

interface CreateKeywordsResponse {
  created: ScreeningKeyword[];
  skippedTerms: string[];
}

export function KeywordToolbar({
  projectId,
  keywords,
  canManage,
  highlightsEnabled,
  keywordGroup,
  onHighlightsEnabledChange,
  onKeywordGroupChange,
  onKeywordsChanged,
}: {
  projectId: string;
  keywords: ScreeningKeyword[] | null;
  canManage: boolean;
  highlightsEnabled: boolean;
  keywordGroup: string;
  onHighlightsEnabledChange: (enabled: boolean) => void;
  onKeywordGroupChange: (group: string) => void;
  onKeywordsChanged: () => Promise<void>;
}) {
  const [termInput, setTermInput] = useState("");
  const [category, setCategory] = useState<ScreeningKeywordCategory>("INCLUDE");
  const [busy, setBusy] = useState(false);
  const [changingId, setChangingId] = useState<string | null>(null);

  const includeKeywords = keywords?.filter((keyword) => keyword.category === "INCLUDE") ?? [];
  const excludeKeywords = keywords?.filter((keyword) => keyword.category === "EXCLUDE") ?? [];

  async function addKeywords(event: React.FormEvent) {
    event.preventDefault();
    const terms = termInput
      .split(/[,\n]/)
      .map((term) => term.trim())
      .filter(Boolean);
    if (terms.length === 0) return;
    setBusy(true);
    try {
      const result = await apiPost<CreateKeywordsResponse>(
        `/api/projects/${projectId}/screening/keywords`,
        { terms, category },
      );
      if (result.created.length > 0) {
        toast.success(
          `${result.created.length} screening keyword${result.created.length === 1 ? "" : "s"} added`,
        );
      }
      if (result.skippedTerms.length > 0) {
        toast.info(
          `${result.skippedTerms.length} existing keyword${result.skippedTerms.length === 1 ? " was" : "s were"} skipped`,
        );
      }
      setTermInput("");
      await onKeywordsChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to add screening keywords");
    } finally {
      setBusy(false);
    }
  }

  async function changeCategory(keyword: ScreeningKeyword, next: ScreeningKeywordCategory) {
    if (keyword.category === next) return;
    setChangingId(keyword.id);
    try {
      await apiPatch(`/api/projects/${projectId}/screening/keywords/${keyword.id}`, {
        category: next,
      });
      await onKeywordsChanged();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to update keyword");
    } finally {
      setChangingId(null);
    }
  }

  async function removeKeyword(keyword: ScreeningKeyword) {
    if (!window.confirm(`Remove the screening keyword “${keyword.term}”?`)) return;
    setChangingId(keyword.id);
    try {
      await apiDelete(`/api/projects/${projectId}/screening/keywords/${keyword.id}`);
      if (keywordGroup === keyword.id) onKeywordGroupChange("ALL");
      await onKeywordsChanged();
      toast.success("Screening keyword removed");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Failed to remove keyword");
    } finally {
      setChangingId(null);
    }
  }

  const hasKeywords = (keywords?.length ?? 0) > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Highlighter className="h-4 w-4 text-muted-foreground" />
        Keyword highlights
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="h-4 w-4 accent-[var(--color-primary)]"
          checked={highlightsEnabled}
          disabled={!hasKeywords}
          onChange={(event) => onHighlightsEnabledChange(event.target.checked)}
        />
        Highlight matches
      </label>
      <div className="flex min-w-64 items-center gap-2">
        <Label htmlFor="screening-keyword-group" className="shrink-0 text-sm">
          Group papers by
        </Label>
        <Select
          id="screening-keyword-group"
          aria-label="Group papers by keyword"
          className="min-w-48"
          value={keywordGroup}
          disabled={!hasKeywords}
          onChange={(event) => onKeywordGroupChange(event.target.value)}
        >
          <option value="ALL">All papers</option>
          {includeKeywords.length > 0 && (
            <optgroup label="Include keywords">
              {includeKeywords.map((keyword) => (
                <option key={keyword.id} value={keyword.id}>
                  Include — {keyword.term}
                </option>
              ))}
            </optgroup>
          )}
          {excludeKeywords.length > 0 && (
            <optgroup label="Exclude keywords">
              {excludeKeywords.map((keyword) => (
                <option key={keyword.id} value={keyword.id}>
                  Exclude — {keyword.term}
                </option>
              ))}
            </optgroup>
          )}
          <option value={UNMATCHED_KEYWORD_GROUP}>No keyword matches</option>
        </Select>
      </div>

      {canManage && (
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="ml-auto">
              <Settings2 /> Manage keywords
              {hasKeywords && <Badge variant="muted">{keywords?.length}</Badge>}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            aria-label="Keyword manager"
            className="w-[26rem] max-w-[calc(100vw-2rem)]"
          >
            <div className="space-y-4">
              <div>
                <h3 className="font-medium">Screening keywords</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Add literal words or phrases. Matches are case-insensitive across titles and
                  abstracts and are shared with the project team.
                </p>
              </div>

              <form onSubmit={addKeywords} className="space-y-2">
                <Label htmlFor="screening-keyword-terms">Words or phrases</Label>
                <Input
                  id="screening-keyword-terms"
                  value={termInput}
                  onChange={(event) => setTermInput(event.target.value)}
                  placeholder="randomized, placebo controlled"
                  disabled={busy}
                />
                <p className="text-[11px] text-muted-foreground">
                  Separate multiple entries with commas.
                </p>
                <div className="flex items-center gap-2">
                  <Select
                    aria-label="Keyword signal"
                    value={category}
                    disabled={busy}
                    onChange={(event) =>
                      setCategory(event.target.value as ScreeningKeywordCategory)
                    }
                  >
                    <option value="INCLUDE">Include signal (green)</option>
                    <option value="EXCLUDE">Exclude signal (red)</option>
                  </Select>
                  <Button type="submit" size="sm" disabled={busy || !termInput.trim()}>
                    {busy ? <Spinner /> : <Plus />} Add
                  </Button>
                </div>
              </form>

              <div className="max-h-64 space-y-1 overflow-y-auto">
                {!hasKeywords ? (
                  <div className="flex items-center gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                    <Tags className="h-4 w-4" /> No keywords yet.
                  </div>
                ) : (
                  keywords?.map((keyword) => (
                    <div
                      key={keyword.id}
                      className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
                    >
                      <Badge variant={keyword.category === "INCLUDE" ? "include" : "exclude"}>
                        {keyword.term}
                      </Badge>
                      <Select
                        aria-label={`Signal for ${keyword.term}`}
                        className="h-8 text-xs"
                        value={keyword.category}
                        disabled={changingId === keyword.id}
                        onChange={(event) =>
                          void changeCategory(
                            keyword,
                            event.target.value as ScreeningKeywordCategory,
                          )
                        }
                      >
                        <option value="INCLUDE">Include</option>
                        <option value="EXCLUDE">Exclude</option>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Remove keyword ${keyword.term}`}
                        disabled={changingId === keyword.id}
                        onClick={() => void removeKeyword(keyword)}
                      >
                        {changingId === keyword.id ? <Spinner /> : <Trash2 />}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}

      {!hasKeywords && !canManage && (
        <p className="text-xs text-muted-foreground">
          No project keywords have been configured yet.
        </p>
      )}
    </div>
  );
}
