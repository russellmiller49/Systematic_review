"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Inbox } from "lucide-react";
import { api, apiPost } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/misc";
import {
  notificationHref,
  notificationLabel,
  notificationSnippet,
  timeAgo,
  type NotificationView,
} from "./notification-utils";

const COUNT_POLL_MS = 60_000;

// Global notification bell (mounted in the app header). Polls the unread count every
// 60s while the tab is visible (+ on focus, per the app's polling convention) and loads
// the latest notifications when the popover opens.
export function NotificationBell() {
  const router = useRouter();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [busy, setBusy] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const { count } = await api<{ count: number }>("/api/notifications/unread-count");
      setCount(count);
    } catch {
      // Background poll — stay silent (results-table convention).
    }
  }, []);

  useEffect(() => {
    loadCount();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") loadCount();
    }, COUNT_POLL_MS);
    const onFocus = () => loadCount();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadCount]);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ notifications: NotificationView[] }>("/api/notifications?limit=20");
      setItems(res.notifications);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setItems(null);
      loadList();
    }
  }, [open, loadList]);

  async function openNotification(n: NotificationView) {
    setOpen(false);
    if (!n.readAt) {
      try {
        await apiPost("/api/notifications/mark-read", { ids: [n.id] });
      } catch {
        // Navigation matters more than the read receipt.
      }
      loadCount();
    }
    router.push(notificationHref(n));
  }

  async function markAllRead() {
    setBusy(true);
    try {
      await apiPost("/api/notifications/mark-all-read", {});
      await Promise.all([loadCount(), loadList()]);
    } catch {
      // Silent — the next poll reconciles.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={count > 0 ? `Notifications (${count} unread)` : "Notifications"}
          className="relative inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Bell className="h-4 w-4" />
          {count > 0 && (
            <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {count > 9 ? "9+" : count}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={markAllRead}
            disabled={busy || count === 0}
          >
            <CheckCheck className="h-3.5 w-3.5" />
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto">
          {items === null ? (
            <div className="flex items-center justify-center py-10">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <Inbox className="h-8 w-8 text-muted-foreground/60" />
              <p className="text-sm text-muted-foreground">You&apos;re all caught up.</p>
            </div>
          ) : (
            items.map((n) => {
              const snippet = notificationSnippet(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openNotification(n)}
                  className={cn(
                    "flex w-full flex-col gap-0.5 border-b border-border px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted",
                    !n.readAt && "bg-accent/40",
                  )}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-sm">
                      <span className="font-medium">{n.actor?.name ?? "Someone"}</span>{" "}
                      <span className="text-muted-foreground">{notificationLabel(n)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {timeAgo(n.createdAt)}
                    </span>
                  </span>
                  {snippet && (
                    <span className="line-clamp-2 text-xs text-muted-foreground">{snippet}</span>
                  )}
                  <span className="text-xs text-muted-foreground/70">{n.project.title}</span>
                </button>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
