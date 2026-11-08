import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("kaboom in chat");
}

test("a crashing page shows a readable error card instead of a blank screen", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}"))));
  render(
    <ErrorBoundary area="workspace:chat">
      <Boom />
    </ErrorBoundary>,
  );
  expect(screen.getByText("This page hit an error")).toBeInTheDocument();
  expect(screen.getByText(/workspace:chat: Error: kaboom in chat/)).toBeInTheDocument();
});
