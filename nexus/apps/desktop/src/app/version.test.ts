import { describe, expect, it } from "vitest";
import { serviceIsOtherVersion } from "./App";

describe("background service version check", () => {
  it("flags a service from other code, and one too old to report a build", () => {
    expect(serviceIsOtherVersion("abc1234", "abc1234")).toBe(false);
    expect(serviceIsOtherVersion("abc1234", "def5678")).toBe(true);
    expect(serviceIsOtherVersion("abc1234", undefined)).toBe(true); // predates the check: certainly older
  });
  it("stays quiet when either side doesn't know its build", () => {
    expect(serviceIsOtherVersion("", "def5678")).toBe(false);
    expect(serviceIsOtherVersion("abc1234", "")).toBe(false);
  });
});
