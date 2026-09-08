import { expect, test } from "bun:test";
import { parseArgs } from "../src/core/args.mjs";

test("no arguments is the hook path on the default host", () => {
  expect(parseArgs([])).toEqual({ command: "--hook", host: "claude-code", days: null });
});

test("--host names a host and is not mistaken for the command", () => {
  expect(parseArgs(["--host", "antigravity"])).toEqual({
    command: "--hook",
    host: "antigravity",
    days: null,
  });
});

test("--host still leaves a later flag as the command", () => {
  const args = parseArgs(["--host", "antigravity", "--status"]);
  expect(args.command).toBe("--status");
  expect(args.host).toBe("antigravity");
});

test("--host with nothing after it keeps the default host", () => {
  expect(parseArgs(["--host"])).toEqual({ command: "--hook", host: "claude-code", days: null });
});

test("--backfill takes a day count", () => {
  expect(parseArgs(["--backfill", "30"])).toEqual({
    command: "--backfill",
    host: "claude-code",
    days: 30,
  });
});

test("--backfill alone leaves days unset, so the caller's default applies", () => {
  expect(parseArgs(["--backfill"]).days).toBeNull();
});

test("--detach is consumed by the launcher and ignored here", () => {
  expect(parseArgs(["--detach"])).toEqual({ command: "--hook", host: "claude-code", days: null });
  expect(parseArgs(["--host", "antigravity", "--detach", "--flush"])).toEqual({
    command: "--flush",
    host: "antigravity",
    days: null,
  });
});

test("an unknown flag becomes the command rather than being dropped", () => {
  expect(parseArgs(["--nonsense"]).command).toBe("--nonsense");
});
