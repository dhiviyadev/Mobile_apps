import { describe, expect, it } from "vitest";
import { serviceIsStale } from "./App";

describe("background service staleness", () => {
  it("trusts the service's own report", () => {
    expect(serviceIsStale({ build: "abc1234", stale: false })).toBe(false);
    expect(serviceIsStale({ build: "abc1234", stale: true })).toBe(true);
    expect(serviceIsStale({ build: "", stale: false })).toBe(false); // not a git checkout: nothing to compare
  });
  it("treats a service too old to report a build as old", () => {
    expect(serviceIsStale({})).toBe(true);
    expect(serviceIsStale(null)).toBe(false); // not connected yet: say nothing
  });
});
