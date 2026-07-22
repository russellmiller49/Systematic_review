import { describe, expect, it } from "vitest";
import { notificationHref, notificationLabel, notificationSnippet, timeAgo } from "./notification-utils";

describe("notificationHref", () => {
  it("routes chat types to the chat page with channel/message params", () => {
    expect(
      notificationHref({
        type: "chat.mention",
        projectId: "p1",
        payload: { channelId: "c1", messageId: "m1" },
      }),
    ).toBe("/projects/p1/chat?channel=c1&message=m1");
    expect(
      notificationHref({ type: "chat.dm", projectId: "p1", payload: {} }),
    ).toBe("/projects/p1/chat");
  });

  it("routes manuscript types to the manuscript page with the section param", () => {
    expect(
      notificationHref({
        type: "manuscript.comment.mention",
        projectId: "p1",
        payload: { sectionId: "s1" },
      }),
    ).toBe("/projects/p1/manuscript?section=s1");
  });

  it("falls back to the project dashboard for unknown types and non-string ids", () => {
    expect(notificationHref({ type: "future.thing", projectId: "p1", payload: {} })).toBe(
      "/projects/p1",
    );
    expect(
      notificationHref({ type: "chat.mention", projectId: "p1", payload: { channelId: 42 } }),
    ).toBe("/projects/p1/chat");
  });
});

describe("notificationLabel / notificationSnippet", () => {
  it("labels known types and defaults unknown ones", () => {
    expect(notificationLabel({ type: "chat.assignment" })).toBe("assigned you a task");
    expect(notificationLabel({ type: "mystery" })).toBe("sent you a notification");
  });

  it("returns the snippet only when it is a non-empty string", () => {
    expect(notificationSnippet({ payload: { snippet: "hello" } })).toBe("hello");
    expect(notificationSnippet({ payload: { snippet: "   " } })).toBeNull();
    expect(notificationSnippet({ payload: {} })).toBeNull();
  });
});

describe("timeAgo", () => {
  const now = new Date("2026-07-21T12:00:00Z");
  it("buckets into just now / minutes / hours / days, then locale date", () => {
    expect(timeAgo("2026-07-21T11:59:40Z", now)).toBe("just now");
    expect(timeAgo("2026-07-21T11:55:00Z", now)).toBe("5m");
    expect(timeAgo("2026-07-21T09:00:00Z", now)).toBe("3h");
    expect(timeAgo("2026-07-19T12:00:00Z", now)).toBe("2d");
    expect(timeAgo("2026-07-01T12:00:00Z", now)).toBe(new Date("2026-07-01T12:00:00Z").toLocaleDateString());
    expect(timeAgo("not-a-date", now)).toBe("");
  });
});
