import { describe, expect, it } from "vitest";
import { publishJobId } from "../src/outbox-job.js";

describe("publish outbox recovery jobs", () => {
  it("keeps the original target id for normal deduplication", () => {
    expect(publishJobId("target-1", undefined)).toBe("target-1");
  });

  it("uses a distinct stable id when PostgreSQL rearms a processed outbox row", () => {
    const key = "a".repeat(32);
    expect(publishJobId("target-1", key)).toBe(`target-1-recovery-${key}`);
    expect(publishJobId("target-1", key)).toBe(`target-1-recovery-${key}`);
    expect(publishJobId("target-1", "unsafe key")).toBe("target-1");
  });
});
