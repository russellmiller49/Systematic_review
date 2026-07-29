"use client";

import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { KeywordHighlightedText } from "@/components/citations/keyword-highlighted-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
  ScreeningKeyword,
  ScreeningNavigatorFilter,
  ScreeningNavigatorItem,
  ScreeningNavigatorResponse,
} from "./types";

const FILTER_LABELS: Record<ScreeningNavigatorFilter, string> = {
  UNDECIDED: "Undecided",
  ONE_REVIEWER: "One screener reviewed",
  DECIDED: "Decided by me",
  INCLUDED: "Included",
  EXCLUDED: "Excluded",
  ALL: "All assigned articles",
};

const FILTER_ORDER: ScreeningNavigatorFilter[] = [
  "UNDECIDED",
  "ONE_REVIEWER",
  "DECIDED",
  "INCLUDED",
  "EXCLUDED",
  "ALL",
];

function filterCount(
  data: ScreeningNavigatorResponse,
  filter: ScreeningNavigatorFilter,
): number {
  switch (filter) {
    case "ALL":
      return data.summary.all;
    case "UNDECIDED":
      return data.summary.undecided;
    case "DECIDED":
      return data.summary.decided;
    case "ONE_REVIEWER":
      return data.summary.oneReviewer;
    case "INCLUDED":
      return data.summary.included;
    case "EXCLUDED":
      return data.summary.excluded;
  }
}

function ArticleStatus({ item }: { item: ScreeningNavigatorItem }) {
  if (item.finalOutcome === "INCLUDE") {
    return <Badge variant="include">Included</Badge>;
  }
  if (item.finalOutcome === "EXCLUDE") {
    return <Badge variant="exclude">Excluded</Badge>;
  }
  if (item.myDecision) {
    const variant =
      item.myDecision.decision === "INCLUDE"
        ? "include"
        : item.myDecision.decision === "EXCLUDE"
          ? "exclude"
          : "maybe";
    return (
      <Badge variant={variant}>
        You: {item.myDecision.decision.toLowerCase()}
      </Badge>
    );
  }
  if (item.completedReviews > 0) {
    return (
      <Badge variant="maybe">
        {item.completedReviews} of {item.requiredReviews} reviewed
      </Badge>
    );
  }
  return <Badge variant="outline">Undecided</Badge>;
}

export function ArticleNavigator({
  data,
  filter,
  selectedId,
  searchDraft,
  keywords,
  highlightsEnabled,
  loading,
  onFilterChange,
  onSelect,
  onSearchDraftChange,
  onSearch,
  onClearSearch,
  onPageChange,
}: {
  data: ScreeningNavigatorResponse;
  filter: ScreeningNavigatorFilter;
  selectedId: string | null;
  searchDraft: string;
  keywords: ScreeningKeyword[];
  highlightsEnabled: boolean;
  loading: boolean;
  onFilterChange: (filter: ScreeningNavigatorFilter) => void;
  onSelect: (citationId: string) => void;
  onSearchDraftChange: (value: string) => void;
  onSearch: () => void;
  onClearSearch: () => void;
  onPageChange: (page: number) => void;
}) {
  const firstShown =
    data.pagination.total === 0
      ? 0
      : (data.pagination.page - 1) * data.pagination.limit + 1;
  const lastShown = Math.min(
    data.pagination.page * data.pagination.limit,
    data.pagination.total,
  );

  return (
    <aside
      aria-label="Article navigator"
      className="flex min-h-[30rem] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]"
    >
      <div className="space-y-3 border-b border-border p-3">
        <div>
          <label
            htmlFor="screening-navigator-filter"
            className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Article list
          </label>
          <Select
            id="screening-navigator-filter"
            aria-label="Filter article status"
            className="mt-1"
            value={filter}
            onChange={(event) => {
              onFilterChange(event.target.value as ScreeningNavigatorFilter);
              event.currentTarget.blur();
            }}
          >
            {FILTER_ORDER.map((option) => (
              <option key={option} value={option}>
                {FILTER_LABELS[option]} ({filterCount(data, option).toLocaleString()})
              </option>
            ))}
          </Select>
        </div>

        <form
          className="flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            onSearch();
          }}
        >
          <Input
            type="search"
            aria-label="Search assigned articles"
            value={searchDraft}
            onChange={(event) => onSearchDraftChange(event.target.value)}
            placeholder="Search titles or abstracts"
            className="min-w-0"
          />
          <Button type="submit" variant="outline" size="icon" aria-label="Search articles">
            <Search />
          </Button>
          {searchDraft && (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear article search"
              onClick={onClearSearch}
            >
              <X />
            </Button>
          )}
        </form>

        <p className="text-xs text-muted-foreground" aria-live="polite">
          Showing {firstShown.toLocaleString()}–{lastShown.toLocaleString()} of{" "}
          {data.pagination.total.toLocaleString()} {FILTER_LABELS[filter].toLowerCase()}
        </p>
      </div>

      <div
        role="listbox"
        aria-label={`${FILTER_LABELS[filter]} articles`}
        aria-busy={loading}
        className={cn(
          "min-h-0 flex-1 divide-y divide-border overflow-y-auto",
          loading && "opacity-60",
        )}
      >
        {data.items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            No articles match this filter.
          </div>
        ) : (
          data.items.map((item, index) => {
            const selected = item.citation.id === selectedId;
            const articleNumber =
              (data.pagination.page - 1) * data.pagination.limit + index + 1;
            return (
              <button
                key={item.citation.id}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => onSelect(item.citation.id)}
                className={cn(
                  "grid w-full grid-cols-[2rem_minmax(0,1fr)] gap-2.5 px-3 py-3 text-left transition-colors hover:bg-muted/60",
                  selected && "bg-primary/5 ring-1 ring-inset ring-primary/25",
                )}
              >
                <span className="pt-0.5 text-xs font-semibold tabular-nums text-muted-foreground">
                  {articleNumber}
                </span>
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm font-medium leading-snug">
                    <KeywordHighlightedText
                      text={item.citation.title}
                      keywords={keywords}
                      enabled={highlightsEnabled}
                    />
                  </span>
                  <span className="mt-1 flex flex-wrap items-center gap-1.5">
                    {item.citation.year && (
                      <span className="text-xs text-muted-foreground">
                        {item.citation.year}
                      </span>
                    )}
                    <ArticleStatus item={item} />
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>

      {data.pagination.totalPages > 1 && (
        <div className="flex items-center justify-between gap-2 border-t border-border p-2.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={data.pagination.page <= 1 || loading}
            onClick={() => onPageChange(data.pagination.page - 1)}
          >
            <ChevronLeft /> Previous
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {data.pagination.page} / {data.pagination.totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              data.pagination.page >= data.pagination.totalPages || loading
            }
            onClick={() => onPageChange(data.pagination.page + 1)}
          >
            Next <ChevronRight />
          </Button>
        </div>
      )}
    </aside>
  );
}
