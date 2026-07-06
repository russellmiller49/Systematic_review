import { describe, expect, it } from "vitest";
import { columnsFor, toCsv } from "./serializers";

describe("toCsv", () => {
  it("renders a simple table with CRLF line endings", () => {
    const csv = toCsv([
      { a: 1, b: "x" },
      { a: 2, b: "y" },
    ]);
    expect(csv).toBe("a,b\r\n1,x\r\n2,y\r\n");
  });

  it("quotes fields containing commas", () => {
    const csv = toCsv([{ title: "Effects of X, Y, and Z" }]);
    expect(csv).toBe('title\r\n"Effects of X, Y, and Z"\r\n');
  });

  it("doubles embedded quotes and wraps the field (RFC 4180)", () => {
    const csv = toCsv([{ note: 'He said "stop"' }]);
    expect(csv).toBe('note\r\n"He said ""stop"""\r\n');
  });

  it("quotes fields containing newlines (LF and CRLF)", () => {
    expect(toCsv([{ note: "line1\nline2" }])).toBe('note\r\n"line1\nline2"\r\n');
    expect(toCsv([{ note: "line1\r\nline2" }])).toBe('note\r\n"line1\r\nline2"\r\n');
  });

  it("passes unicode through untouched", () => {
    const csv = toCsv([{ author: "Müller, José 中文 🔬" }]);
    expect(csv).toBe('author\r\n"Müller, José 中文 🔬"\r\n');
  });

  it("renders null/undefined as empty fields and booleans/dates canonically", () => {
    const csv = toCsv([
      { a: null, b: undefined, c: true, d: new Date("2026-01-02T03:04:05.000Z") },
    ]);
    expect(csv).toBe("a,b,c,d\r\n,,true,2026-01-02T03:04:05.000Z\r\n");
  });

  it("computes the column union in first-seen order across heterogeneous rows", () => {
    const rows = [
      { recordType: "decision", stage: "TITLE_ABSTRACT" },
      { recordType: "adjudication", reason: "tie-break" },
    ];
    expect(columnsFor(rows)).toEqual(["recordType", "stage", "reason"]);
    const csv = toCsv(rows);
    expect(csv).toBe(
      "recordType,stage,reason\r\ndecision,TITLE_ABSTRACT,\r\nadjudication,,tie-break\r\n",
    );
  });

  it("respects an explicit column order and ignores extra keys", () => {
    const csv = toCsv([{ b: 2, a: 1, z: 9 }], ["a", "b"]);
    expect(csv).toBe("a,b\r\n1,2\r\n");
  });

  it("quotes header cells that need quoting", () => {
    const csv = toCsv([{ 'weird,"col"': "v" }]);
    expect(csv).toBe('"weird,""col"""\r\nv\r\n');
  });

  it("returns an empty string for no rows and no columns", () => {
    expect(toCsv([])).toBe("");
  });
});
