import { cn } from "@/lib/utils";
import {
  segmentScreeningKeywordText,
  type ScreeningKeywordRule,
} from "@/lib/screening-keywords";

export function KeywordHighlightedText({
  text,
  keywords,
  enabled = true,
  className,
}: {
  text: string;
  keywords: readonly ScreeningKeywordRule[];
  enabled?: boolean;
  className?: string;
}) {
  if (!enabled || keywords.length === 0) return <>{text}</>;
  return (
    <>
      {segmentScreeningKeywordText(text, keywords).map((segment, index) =>
        segment.keyword ? (
          <mark
            key={`${index}:${segment.keyword.id}`}
            data-screening-keyword={segment.keyword.id}
            data-keyword-term={segment.keyword.term}
            title={`${segment.keyword.category === "INCLUDE" ? "Include" : "Exclude"} keyword: ${segment.keyword.term}`}
            className={cn(
              "rounded-sm px-0.5 font-medium",
              segment.keyword.category === "INCLUDE"
                ? "bg-emerald-200 text-emerald-950"
                : "bg-rose-200 text-rose-950",
              className,
            )}
          >
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
