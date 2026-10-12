import { describe, expect, it } from "vitest";
import { initialScreeningQueue, pooledScopeLabel, screeningQueueHref } from "./screening-scope";

describe("configured screening entry", () => {
  it("names actual noncontiguous pool membership without assuming a study's range", () => {
    expect(
      pooledScopeLabel([
        { id: "a", title: "A", picoNumber: 2 },
        { id: "b", title: "B", picoNumber: 4 },
      ]),
    ).toBe("PICOs 2, 4 together");
  });
  it("honors explicit individual and combined entry instead of defaulting to the pool", () => {
    expect(initialScreeningQueue("pico:one", "saved", ["one", "other"])).toBe("pico:one");
    expect(initialScreeningQueue("pool:saved", "saved", ["one"])).toBe("pool:saved");
    expect(initialScreeningQueue(null, "saved", ["one"])).toBe("pool:saved");
    expect(initialScreeningQueue(null, null, ["one"])).toBe("pico:one");
  });
  it("fails closed for stale links and pooled-PICO individual requests", () => {
    expect(initialScreeningQueue("", "saved", ["one"])).toBeNull();
    expect(initialScreeningQueue("pool:removed", "saved", ["one"])).toBeNull();
    expect(initialScreeningQueue("pico:pooled", "saved", ["one"])).toBeNull();
    expect(initialScreeningQueue(null, null, [])).toBeNull();
    expect(screeningQueueHref("family", "pool:saved")).toBe(
      "/projects/family/screening?queue=pool%3Asaved",
    );
  });
});
