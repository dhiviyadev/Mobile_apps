import { bytes, greeting, highlightSegments, relTime } from "./format";

test("highlight markers become safe segments, never HTML", () => {
  const segs = highlightSegments("the \u0002Falcon\u0003 <b>ships</b>");
  expect(segs).toEqual([
    { text: "the ", hit: false },
    { text: "Falcon", hit: true },
    { text: " <b>ships</b>", hit: false },
  ]);
});

test("bytes and greeting", () => {
  expect(bytes(24 * 1024 ** 3, 0)).toBe("24 GB");
  expect(bytes(null)).toBe("—");
  expect(greeting(new Date(2026, 0, 1, 9), "Dhiviya")).toBe("Good morning, Dhiviya");
  expect(greeting(new Date(2026, 0, 1, 20))).toBe("Good evening");
});

test("relative time", () => {
  expect(relTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5m ago");
  expect(relTime(null)).toBe("—");
});
