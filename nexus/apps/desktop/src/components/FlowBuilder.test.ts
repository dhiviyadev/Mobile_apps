import { describe, expect, it } from "vitest";
import { stripKeys, withKeys } from "./FlowBuilder";
import { QUICK_ACTIONS, quickPrompt } from "@/app/MiniApp";

describe("flow builder keys", () => {
  it("gives every step a stable key and removes it before saving", () => {
    const keyed = withKeys([{ type: "notify", title: "Hi" }, { type: "prompt", prompt: "x" }]);
    expect(new Set(keyed.map((k) => k._key)).size).toBe(2);
    expect(withKeys(keyed).map((k) => k._key)).toEqual(keyed.map((k) => k._key));
    expect(stripKeys(keyed)).toEqual([{ type: "notify", title: "Hi" }, { type: "prompt", prompt: "x" }]);
  });
});

describe("quick actions", () => {
  it("wraps the copied text after the instruction", () => {
    const p = quickPrompt(QUICK_ACTIONS[0]!, "  hello world \n");
    expect(p.startsWith(QUICK_ACTIONS[0]!.prompt)).toBe(true);
    expect(p.endsWith('"""\nhello world\n"""')).toBe(true);
  });
});
