// Mention token grammar shared by the composer (insert) and message rendering (display)
// and the server (extraction). Pure and isomorphic — zero imports (quote-match precedent).
//
// Tokens: @[Display Name](userId) for user mentions, literal @channel for everyone.

export interface ParsedMentions {
  userIds: string[];
  hasChannelMention: boolean;
}

const TOKEN_RE = /@\[([^\]\n]{1,120})\]\(([A-Za-z0-9_-]{1,64})\)/g;

export function parseMentions(body: string): ParsedMentions {
  const userIds: string[] = [];
  for (const match of body.matchAll(TOKEN_RE)) {
    const id = match[2]!;
    if (!userIds.includes(id)) userIds.push(id);
  }
  const hasChannelMention = /(^|\s)@channel(\s|$|[.,!?])/.test(body);
  return { userIds, hasChannelMention };
}

export function insertMention(body: string, name: string, userId: string): string {
  const token = `@[${name.replace(/[[\]()]/g, "")}](${userId})`;
  const needsSpace = body.length > 0 && !/\s$/.test(body);
  return `${body}${needsSpace ? " " : ""}${token} `;
}

export type MentionSegment =
  | { type: "text"; text: string }
  | { type: "mention"; name: string; userId: string }
  | { type: "channel" };

// Split a body into renderable segments (mention pills + plain text).
export function splitMentionSegments(body: string): MentionSegment[] {
  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const match of body.matchAll(TOKEN_RE)) {
    const start = match.index;
    if (start > cursor) pushText(segments, body.slice(cursor, start));
    segments.push({ type: "mention", name: match[1]!, userId: match[2]! });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) pushText(segments, body.slice(cursor));
  return segments;
}

function pushText(segments: MentionSegment[], text: string) {
  // Split out literal @channel occurrences within plain text runs.
  const re = /(^|\s)(@channel)(?=\s|$|[.,!?])/g;
  let cursor = 0;
  for (const match of text.matchAll(re)) {
    const start = match.index + match[1]!.length;
    if (start > cursor) segments.push({ type: "text", text: text.slice(cursor, start) });
    segments.push({ type: "channel" });
    cursor = start + match[2]!.length;
  }
  if (cursor < text.length) segments.push({ type: "text", text: text.slice(cursor) });
}

// Display form (used for previews/snippets): tokens collapse to @Name.
export function mentionsToPlainText(body: string): string {
  return body.replace(TOKEN_RE, "@$1");
}
