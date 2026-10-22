import { Button } from "@/components/ui/button";
import { Progress, Skeleton } from "@/components/ui/misc";
import type { ReviewerQuota } from "./types";

// Counts come from the authenticated queue response. Never derive a target or
// remaining workload from the number of articles currently available.
export function PersonalScreeningProgress({
  quota,
  available,
  context,
  loading = false,
  refreshing = false,
  error,
  continuing = false,
  onContinue,
}: {
  quota: ReviewerQuota | null | undefined;
  available?: number;
  context: string;
  loading?: boolean;
  refreshing?: boolean;
  error?: string | null;
  continuing?: boolean;
  onContinue?: () => void;
}) {
  return (
    <section
      aria-label="Your reviewer quota"
      aria-busy={loading || refreshing}
      className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-4 sm:p-5"
    >
      <h2 className="font-semibold">Personal screening progress</h2>
      <p className="mt-1 text-sm text-muted-foreground">{context}</p>
      {loading ? (
        <div role="status" className="mt-3 space-y-2">
          <Skeleton className="h-8 w-full max-w-md" />
          <p className="text-sm">Loading your screening progress…</p>
        </div>
      ) : error ? (
        <p role="status" className="mt-3 text-sm">
          Personal progress could not be refreshed. Retry to load current
          counts.
        </p>
      ) : !quota ? (
        <>
          <p className="mt-3 text-xl font-semibold">
            No personal target assigned
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            Completed and remaining totals are not specified. Fixed assignments
            and saved reviews may still appear below; ask an Owner or Admin to
            confirm your workload.
          </p>
        </>
      ) : (
        <>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="mt-3 text-2xl font-semibold leading-snug tabular-nums sm:text-3xl"
          >
            <span role="group" aria-label="Reviews completed">
              {quota.completed.toLocaleString()}
            </span>
            {quota.target === null ? (
              <> {quota.completed === 1 ? "review" : "reviews"} completed</>
            ) : (
              <>
                {quota.target > 0 && <> of {quota.target.toLocaleString()}</>}{" "}
                completed ·{" "}
                <span role="group" aria-label="Reviews remaining">
                  {quota.remaining?.toLocaleString()}
                </span>{" "}
                remaining
              </>
            )}
          </p>
          {quota.target !== null && quota.target > 0 && (
            <div
              role="progressbar"
              aria-label="Progress toward your assigned target"
              aria-valuemin={0}
              aria-valuemax={quota.target}
              aria-valuenow={Math.min(quota.completed, quota.target)}
              aria-valuetext={`${quota.completed.toLocaleString()} of ${quota.target.toLocaleString()} completed; ${quota.remaining?.toLocaleString()} remaining`}
              className="mt-3"
            >
              <Progress value={(quota.completed / quota.target) * 100} />
            </div>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            {quota.target === null
              ? "No numerical target set; remaining reviews are not specified."
              : quota.target === 0
                ? "Assigned target: 0. New reviews are paused; completed reviews remain saved."
                : quota.completed > quota.target
                  ? "Target reached. Completed reviews exceed the current target and remain counted."
                  : quota.remaining === 0
                    ? "Target reached. Your completed reviews remain saved."
                    : "Your assigned target is a progress goal. Each abstract counts once toward it."}
          </p>
          {quota.target !== null &&
            quota.target > 0 &&
            quota.remaining === 0 && (
              <div className="mt-3 space-y-2 text-sm">
                <p>
                  You may stop here or voluntarily review more eligible
                  abstracts. Your target stays the same.
                </p>
                {continuing ? (
                  <p>Continuing beyond your target for this session.</p>
                ) : available !== undefined && available > 0 && onContinue ? (
                  <Button onClick={onContinue} disabled={refreshing}>
                    Continue screening
                  </Button>
                ) : null}
              </div>
            )}
        </>
      )}
      {!loading && !error && available !== undefined && (
        <div className="mt-3 border-t border-primary/15 pt-3 text-sm">
          <p>
            Available to review: <strong>{available.toLocaleString()}</strong>
          </p>
          {available === 0 && quota?.target !== 0 && (
            <p className="mt-1">
              No eligible articles remaining in this view. This is separate from
              your target; filters or new shared work may change availability.
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Available articles are queue choices, not your remaining assigned
            reviews. An empty article view does not confirm assignment
            completion.
          </p>
        </div>
      )}
      {refreshing && !loading && !error && (
        <p className="mt-2 text-xs text-muted-foreground">
          Updating — showing last confirmed counts…
        </p>
      )}
    </section>
  );
}
