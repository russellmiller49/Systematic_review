"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Eye, RefreshCw, Search, ShieldCheck, TriangleAlert } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { formatAuthors } from "@/components/citations/citation-card";
import { KeywordHighlightedText } from "@/components/citations/keyword-highlighted-text";
import { matchingScreeningKeywords } from "@/lib/screening-keywords";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, EmptyState, Skeleton } from "@/components/ui/misc";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  AdminOverviewFilter,
  AdminOverviewResponse,
  AdminOverviewState,
  ScreeningKeyword,
  ScreeningStageSummary,
} from "./types";

const FILTER_LABELS: Record<AdminOverviewFilter, string> = {
  ALL: "All",
  UNASSIGNED: "Unassigned",
  NOT_STARTED: "Not started",
  IN_PROGRESS: "In progress",
  CONFLICT: "Conflict",
  INCLUDED: "Included",
  EXCLUDED: "Excluded",
};

const STATE_VARIANTS: Record<
  AdminOverviewState,
  "muted" | "outline" | "maybe" | "destructive" | "include" | "exclude"
> = {
  UNASSIGNED: "muted",
  NOT_STARTED: "outline",
  IN_PROGRESS: "maybe",
  CONFLICT: "destructive",
  INCLUDED: "include",
  EXCLUDED: "exclude",
};

const PAGE_SIZE = 25;

function summaryCount(
  data: AdminOverviewResponse,
  filter: AdminOverviewFilter,
): number {
  switch (filter) {
    case "ALL":
      return data.summary.totalEligible;
    case "UNASSIGNED":
      return data.summary.unassigned;
    case "NOT_STARTED":
      return data.summary.notStarted;
    case "IN_PROGRESS":
      return data.summary.inProgress;
    case "CONFLICT":
      return data.summary.conflicts;
    case "INCLUDED":
      return data.summary.included;
    case "EXCLUDED":
      return data.summary.excluded;
  }
}

export function AdminScreeningOverview({
  projectId,
  stage,
  keywords,
  highlightsEnabled,
  keywordGroup,
}: {
  projectId: string;
  stage: ScreeningStageSummary;
  keywords: ScreeningKeyword[];
  highlightsEnabled: boolean;
  keywordGroup: string;
}) {
  const [filter, setFilter] = useState<AdminOverviewFilter>("ALL");
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      status: filter,
      page: String(page),
      limit: String(PAGE_SIZE),
    });
    if (query) params.set("q", query);
    if (keywordGroup !== "ALL") params.set("keywordGroup", keywordGroup);
    try {
      const next = await api<AdminOverviewResponse>(
        `/api/projects/${projectId}/screening/stages/${stage.id}/admin-overview?${params}`,
      );
      setData(next);
      if (next.pagination.page !== page) setPage(next.pagination.page);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load the admin screening view");
    } finally {
      setLoading(false);
    }
  }, [filter, keywordGroup, page, projectId, query, reloadKey, stage.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function chooseFilter(next: AdminOverviewFilter) {
    setFilter(next);
    setPage(1);
  }

  function search(e: React.FormEvent) {
    e.preventDefault();
    setQuery(draftQuery.trim());
    setPage(1);
  }

  if (data === null && loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-7">
          {Array.from({ length: 7 }, (_, index) => (
            <Skeleton key={index} className="h-16" />
          ))}
        </div>
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  if (data === null && error) {
    return (
      <EmptyState
        icon={TriangleAlert}
        title="Couldn't load the admin view"
        description={error}
        action={
          <Button variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
            <RefreshCw /> Try again
          </Button>
        }
      />
    );
  }

  if (data === null) return null;

  const firstShown =
    data.pagination.total === 0
      ? 0
      : (data.pagination.page - 1) * data.pagination.limit + 1;
  const lastShown = Math.min(
    data.pagination.page * data.pagination.limit,
    data.pagination.total,
  );
  const filters = Object.keys(FILTER_LABELS) as AdminOverviewFilter[];

  return (
    <div className="space-y-5">
      <Alert>
        <span className="flex items-start gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            <strong>Admin oversight:</strong> this view includes every citation eligible for this
            stage, including unassigned work. Reviewer identities and completion status are shown,
            but individual screening choices and notes remain hidden
            {data.stage.blinded ? " while screening is blinded" : ""}.
          </span>
        </span>
      </Alert>

      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-7">
        {filters.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={filter === item}
            onClick={() => chooseFilter(item)}
            className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
              filter === item
                ? "border-primary bg-primary/5 ring-1 ring-primary"
                : "border-border bg-card hover:bg-muted/60"
            }`}
          >
            <span className="block text-xs text-muted-foreground">{FILTER_LABELS[item]}</span>
            <span className="mt-0.5 block text-lg font-semibold">
              {summaryCount(data, item).toLocaleString()}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <form onSubmit={search} className="flex min-w-0 flex-1 gap-2 sm:max-w-lg">
          <Input
            type="search"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Search article titles"
            aria-label="Search article titles"
          />
          <Button type="submit" variant="outline">
            <Search /> Search
          </Button>
          {query && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraftQuery("");
                setQuery("");
                setPage(1);
              }}
            >
              Clear
            </Button>
          )}
        </form>
        <Select
          aria-label="Filter screening status"
          className="w-44"
          value={filter}
          onChange={(event) => chooseFilter(event.target.value as AdminOverviewFilter)}
        >
          {filters.map((item) => (
            <option key={item} value={item}>
              {FILTER_LABELS[item]}
            </option>
          ))}
        </Select>
      </div>

      {error && (
        <Alert variant="error">
          <span className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button variant="outline" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
              <RefreshCw /> Retry
            </Button>
          </span>
        </Alert>
      )}

      {data.items.length === 0 ? (
        <EmptyState
          icon={Eye}
          title="No articles match this view"
          description={
            query
              ? `No ${FILTER_LABELS[filter].toLowerCase()} articles match “${query}”.`
              : `There are no ${FILTER_LABELS[filter].toLowerCase()} articles at this stage.`
          }
        />
      ) : (
        <div className={loading ? "opacity-60" : undefined} aria-busy={loading}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead className="w-72">Reviewer progress</TableHead>
                <TableHead className="w-32">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((item) => {
                const citation = item.citation;
                const progress = item.assignmentProgress;
                const matchedKeywords = matchingScreeningKeywords(
                  [citation.title, citation.abstract],
                  keywords,
                );
                return (
                  <TableRow key={citation.id}>
                    <TableCell className="min-w-[28rem] py-4 align-top">
                      <p className="font-medium leading-snug">
                        <KeywordHighlightedText
                          text={citation.title}
                          keywords={keywords}
                          enabled={highlightsEnabled}
                        />
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {formatAuthors(citation.authors, 4)}
                        {citation.journal ? ` · ${citation.journal}` : ""}
                        {citation.year ? ` · ${citation.year}` : ""}
                      </p>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {citation.sources.map((source) => (
                          <Badge key={source} variant="secondary">
                            {source}
                          </Badge>
                        ))}
                        {matchedKeywords.map((keyword) => (
                          <Badge
                            key={keyword.id}
                            variant={keyword.category === "INCLUDE" ? "include" : "exclude"}
                            data-screening-keyword-badge={keyword.id}
                          >
                            {keyword.term}
                          </Badge>
                        ))}
                        {citation.pmid && <Badge variant="outline">PMID {citation.pmid}</Badge>}
                        {citation.doi && <Badge variant="outline">DOI {citation.doi}</Badge>}
                      </div>
                      {citation.abstract && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer font-medium text-primary">
                            View abstract
                          </summary>
                          <p className="mt-2 whitespace-pre-line leading-relaxed text-muted-foreground">
                            <KeywordHighlightedText
                              text={citation.abstract}
                              keywords={keywords}
                              enabled={highlightsEnabled}
                            />
                          </p>
                        </details>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      {item.reviewers.length === 0 ? (
                        <p className="text-sm font-medium text-muted-foreground">
                          No reviewers assigned
                        </p>
                      ) : (
                        <>
                          <p className="text-sm font-medium">
                            {progress.completed} of {progress.required} required review
                            {progress.required === 1 ? "" : "s"} submitted
                          </p>
                          {progress.assigned !== progress.required && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              {progress.assigned} reviewer
                              {progress.assigned === 1 ? "" : "s"} assigned
                            </p>
                          )}
                          <ul className="mt-2 space-y-1">
                            {item.reviewers.map((reviewer) => (
                              <li
                                key={reviewer.id}
                                className="flex items-center justify-between gap-2 text-xs"
                              >
                                <span className="truncate" title={reviewer.email}>
                                  {reviewer.name}
                                </span>
                                <Badge
                                  variant={reviewer.status === "COMPLETED" ? "include" : "muted"}
                                >
                                  {reviewer.status === "COMPLETED" ? "Submitted" : "Pending"}
                                </Badge>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge variant={STATE_VARIANTS[item.state]}>
                        {FILTER_LABELS[item.state]}
                      </Badge>
                      {item.state === "CONFLICT" && (
                        <Link
                          href={`/projects/${projectId}/conflicts`}
                          className="mt-2 block text-xs font-medium text-primary hover:underline"
                        >
                          Review conflict
                        </Link>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>
          Showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of{" "}
          {data.pagination.total.toLocaleString()}
          {query ? ` matching “${query}”` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={loading || data.pagination.page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </Button>
          <span>
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={loading || data.pagination.page >= data.pagination.totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
