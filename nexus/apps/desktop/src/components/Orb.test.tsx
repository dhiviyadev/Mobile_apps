import { render } from "@testing-library/react";
import { Orb } from "./Orb";

test.each(["idle", "listening", "thinking", "executing"] as const)("orb renders %s state", (state) => {
  const { getByRole } = render(<Orb state={state} size={80} />);
  const el = getByRole("img");
  expect(el).toHaveAttribute("data-state", state);
  expect(el).toHaveAttribute("aria-label", `NEXUS is ${state}`);
});
