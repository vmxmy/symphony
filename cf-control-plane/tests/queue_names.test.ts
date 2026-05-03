import { describe, expect, test } from "bun:test";
import { isDispatchQueue, isTrackerEventsQueue } from "../src/queues/names.js";

describe("queue name discrimination", () => {
  test("accepts production queue names", () => {
    expect(isTrackerEventsQueue("symphony-tracker-events")).toBe(true);
    expect(isDispatchQueue("symphony-dispatch")).toBe(true);
  });

  test("accepts environment-suffixed queue names", () => {
    expect(isTrackerEventsQueue("symphony-tracker-events-staging")).toBe(true);
    expect(isDispatchQueue("symphony-dispatch-staging")).toBe(true);
    expect(isDispatchQueue("symphony-dispatch-preview-123")).toBe(true);
  });

  test("rejects adjacent but different queue names", () => {
    expect(isTrackerEventsQueue("symphony-tracker-eventsx")).toBe(false);
    expect(isDispatchQueue("symphony-dispatcher")).toBe(false);
    expect(isDispatchQueue("other-symphony-dispatch-staging")).toBe(false);
  });
});
