import { describe, expect, it } from "vitest";
import { AppError } from "@/server/errors";
import { validateFieldValue, valuesEqual } from "./validation";

const field = (type: Parameters<typeof validateFieldValue>[0]["type"], options: unknown = null) => ({
  key: "k",
  type,
  options,
});

const opts = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

function expectValidationError(fn: () => unknown) {
  try {
    fn();
    expect.fail("expected AppError(VALIDATION)");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe("VALIDATION");
  }
}

describe("validateFieldValue", () => {
  it("TEXT/TEXTAREA accept strings only", () => {
    expect(validateFieldValue(field("TEXT"), "hello")).toBe("hello");
    expect(validateFieldValue(field("TEXTAREA"), "long text")).toBe("long text");
    expectValidationError(() => validateFieldValue(field("TEXT"), 42));
    expectValidationError(() => validateFieldValue(field("TEXTAREA"), ["a"]));
  });

  it("NUMBER accepts finite numbers only", () => {
    expect(validateFieldValue(field("NUMBER"), 3.14)).toBe(3.14);
    expect(validateFieldValue(field("NUMBER"), -7)).toBe(-7);
    expectValidationError(() => validateFieldValue(field("NUMBER"), "12"));
    expectValidationError(() => validateFieldValue(field("NUMBER"), Number.NaN));
    expectValidationError(() => validateFieldValue(field("NUMBER"), Number.POSITIVE_INFINITY));
  });

  it("DATE accepts real yyyy-mm-dd dates only", () => {
    expect(validateFieldValue(field("DATE"), "2021-12-31")).toBe("2021-12-31");
    expectValidationError(() => validateFieldValue(field("DATE"), "2021-02-30")); // not a real day
    expectValidationError(() => validateFieldValue(field("DATE"), "31/12/2021"));
    expectValidationError(() => validateFieldValue(field("DATE"), 20211231));
  });

  it("BOOLEAN accepts booleans only", () => {
    expect(validateFieldValue(field("BOOLEAN"), true)).toBe(true);
    expect(validateFieldValue(field("BOOLEAN"), false)).toBe(false);
    expectValidationError(() => validateFieldValue(field("BOOLEAN"), "true"));
  });

  it("SINGLE_SELECT requires a configured option value", () => {
    expect(validateFieldValue(field("SINGLE_SELECT", opts), "a")).toBe("a");
    expectValidationError(() => validateFieldValue(field("SINGLE_SELECT", opts), "c"));
    expectValidationError(() => validateFieldValue(field("SINGLE_SELECT", opts), ["a"]));
  });

  it("MULTI_SELECT requires a non-empty unique subset of options", () => {
    expect(validateFieldValue(field("MULTI_SELECT", opts), ["a", "b"])).toEqual(["a", "b"]);
    expectValidationError(() => validateFieldValue(field("MULTI_SELECT", opts), []));
    expectValidationError(() => validateFieldValue(field("MULTI_SELECT", opts), ["a", "z"]));
    expectValidationError(() => validateFieldValue(field("MULTI_SELECT", opts), ["a", "a"]));
    expectValidationError(() => validateFieldValue(field("MULTI_SELECT", opts), "a"));
  });
});

describe("valuesEqual", () => {
  it("treats missing as null and null as equal to null only", () => {
    expect(valuesEqual("TEXT", undefined, null)).toBe(true);
    expect(valuesEqual("TEXT", null, "x")).toBe(false);
  });

  it("compares primitives and deep JSON", () => {
    expect(valuesEqual("NUMBER", 1, 1)).toBe(true);
    expect(valuesEqual("NUMBER", 1, 2)).toBe(false);
    expect(valuesEqual("TEXT", "a", "a")).toBe(true);
    expect(valuesEqual("BOOLEAN", true, false)).toBe(false);
  });

  it("MULTI_SELECT is order-insensitive", () => {
    expect(valuesEqual("MULTI_SELECT", ["a", "b"], ["b", "a"])).toBe(true);
    expect(valuesEqual("MULTI_SELECT", ["a"], ["a", "b"])).toBe(false);
    expect(valuesEqual("MULTI_SELECT", ["a", "a"], ["a", "b"])).toBe(false);
  });
});
