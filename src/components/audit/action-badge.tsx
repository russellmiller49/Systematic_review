import { Badge, type BadgeProps } from "@/components/ui/badge";

// Tint audit actions by their final verb so scanning a feed gives an at-a-glance
// sense of what happened: green = things coming into being / succeeding,
// red = removals & failures, amber = attention-worthy state flips (conflicts,
// adjudications, unblinding, reopens), neutral for plain edits.
const EXCLUDE_VERBS = /(deleted|removed|revoked|failed|rejected|unlinked)$/;
const MAYBE_VERBS = /(adjudicated|unblinded|reopened|opened|undone|amended)$/;
const INCLUDE_VERBS = /(created|added|accepted|committed|merged|completed|published|uploaded|linked|recorded)$/;

function variantFor(action: string): BadgeProps["variant"] {
  if (EXCLUDE_VERBS.test(action)) return "exclude";
  if (MAYBE_VERBS.test(action)) return "maybe";
  if (INCLUDE_VERBS.test(action)) return "include";
  return "secondary";
}

export function ActionBadge({ action }: { action: string }) {
  return (
    <Badge variant={variantFor(action)} className="font-mono text-[11px] leading-4">
      {action}
    </Badge>
  );
}
