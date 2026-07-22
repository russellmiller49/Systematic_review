import { describe, expect, it } from "vitest";
import {
  insertMention,
  mentionsToPlainText,
  parseMentions,
  splitMentionSegments,
} from "./mentions";

describe("parseMentions", () => {
  it("extracts deduped user ids and the @channel flag", () => {
    const body =
      "Hey @[Ravi Reviewer](user1) and @[Sam](user2) — also @[Ravi Reviewer](user1), @channel please read.";
    expect(parseMentions(body)).toEqual({
      userIds: ["user1", "user2"],
      hasChannelMention: true,
    });
  });

  it("ignores malformed tokens and emails; @channel needs word boundaries", () => {
    expect(parseMentions("@[Broken](with spaces id) @[]() someone@channel.org")).toEqual({
      userIds: [],
      hasChannelMention: false,
    });
    expect(parseMentions("@channel").hasChannelMention).toBe(true);
    expect(parseMentions("ping @channel!").hasChannelMention).toBe(true);
  });
});

describe("insertMention", () => {
  it("adds a token with spacing and strips brackets from names", () => {
    expect(insertMention("", "Jane", "u1")).toBe("@[Jane](u1) ");
    expect(insertMention("hello", "Jane [x]", "u1")).toBe("hello @[Jane x](u1) ");
  });
});

describe("splitMentionSegments", () => {
  it("splits text, mention pills, and @channel", () => {
    const segments = splitMentionSegments("Hi @[Jane](u1), see @channel notes");
    expect(segments).toEqual([
      { type: "text", text: "Hi " },
      { type: "mention", name: "Jane", userId: "u1" },
      { type: "text", text: ", see " },
      { type: "channel" },
      { type: "text", text: " notes" },
    ]);
  });
});

describe("mentionsToPlainText", () => {
  it("collapses tokens to @Name", () => {
    expect(mentionsToPlainText("Hi @[Jane Doe](u1)!")).toBe("Hi @Jane Doe!");
  });
});
