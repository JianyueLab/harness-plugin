import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_API_URL,
  configProblem,
  execVaultCmd,
  expandTilde,
  loadWakaConfig,
  parseWakaCfg,
  redactKey,
  splitVaultCmd,
} from "../src/wakatime/cfg.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-cfg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const writeFile = (name, body) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
  return p;
};

/** Write an executable shell script under the temp root. Never the developer's real home. */
const writeScript = (name, body) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
};

// --- subprocess probe, for the two things this process can't observe about
// itself: another process's own stderr stream, and os.homedir() under a
// $HOME this process didn't start with (Bun reads $HOME once at process
// launch, not from a runtime-mutated process.env.HOME -- verified directly:
// Node picks up a post-launch process.env.HOME change, Bun does not, so a
// real subprocess with `env` set at spawn time is the only portable way to
// exercise this). Never touches the developer's real $HOME unless a test
// explicitly passes it in `env`, which none do.
const CFG_MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "wakatime", "cfg.mjs"),
).href;
let probeCounter = 0;
const runProbe = (body, { env } = {}) => {
  const probePath = writeFile(
    `probe-${probeCounter++}.mjs`,
    `import { execVaultCmd, splitVaultCmd } from ${JSON.stringify(CFG_MODULE_URL)};\n${body}`,
  );
  return spawnSync(process.execPath, [probePath], { encoding: "utf8", env: env ?? process.env });
};

test("parses only [settings], and survives everything else in the file", () => {
  const got = parseWakaCfg(`
# a comment
[settings]
api_key = waka_abcd-1234
api_url = https://wakapi.example/api/v1
hide_file_names = true
exclude =
    ^/tmp/
    ^/private/
proxy = https://user:pass@host:port

[git]
disable_submodules = true
`);
  expect(got.api_key).toBe("waka_abcd-1234");
  expect(got.api_url).toBe("https://wakapi.example/api/v1");
  expect(got.hide_file_names).toBe("true");
  // Keys outside [settings] must not leak in — [git]'s value would otherwise
  // become a stray field.
  expect(got.disable_submodules).toBeUndefined();
  // Keys inside [settings] but not whitelisted must also not leak — proxy
  // carries credentials and exclude carries patterns.
  expect(got.proxy).toBeUndefined();
  expect(got.exclude).toBeUndefined();
});

test("a malformed cfg is not fatal", () => {
  expect(() => parseWakaCfg("]]] not ini at all\n\x00\x01")).not.toThrow();
  expect(parseWakaCfg("")).toEqual({});
});

test("env beats cfg beats json", () => {
  const cfgPath = writeFile("wakatime.cfg", "[settings]\napi_key = from_cfg\napi_url = https://cfg.example/api/v1\n");
  const jsonPath = writeFile("config.json", JSON.stringify({ apiKey: "from_json", apiUrl: "https://json.example/api/v1" }));

  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath }).apiKey).toBe("from_cfg");
  expect(loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath }).apiKey).toBe("from_json");
  expect(loadWakaConfig({ env: { WAKATIME_API_KEY: "from_env" }, cfgPath, jsonPath }).apiKey).toBe("from_env");
});

test("api url defaults, and a trailing slash is trimmed", () => {
  expect(loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath: "/nope" }).apiUrl).toBe(DEFAULT_API_URL);

  const cfgPath = writeFile("slash.cfg", "[settings]\napi_url = https://wakapi.example/api/v1///\n");
  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" }).apiUrl).toBe("https://wakapi.example/api/v1");
});

test("hide_file_names is read from the cfg", () => {
  const cfgPath = writeFile("hide.cfg", "[settings]\napi_key = k\nhide_file_names = true\n");
  expect(loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" }).hideFileNames).toBe(true);

  const off = writeFile("show.cfg", "[settings]\napi_key = k\n");
  expect(loadWakaConfig({ env: {}, cfgPath: off, jsonPath: "/nope" }).hideFileNames).toBe(false);
});

test("missing key is a clean problem, not a throw", () => {
  const cfg = loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath: "/nope" });
  expect(cfg.apiKey).toBe("");
  expect(configProblem(cfg)).toBe("no API key configured");
});

test("JYL_WAKATIME_DISABLED switches it off", () => {
  const cfgPath = writeFile("on.cfg", "[settings]\napi_key = k\n");
  const cfg = loadWakaConfig({ env: { JYL_WAKATIME_DISABLED: "1" }, cfgPath, jsonPath: "/nope" });
  expect(configProblem(cfg)).toBe("disabled");
});

test("redactKey never shows the middle", () => {
  expect(redactKey("waka_0123456789abcdef")).toBe("waka…cdef");
  expect(redactKey("")).toBe("(unset)");
  expect(redactKey("short")).toBe("…");
});

// --- api_key_vault_cmd -------------------------------------------------

test("parseWakaCfg picks up api_key_vault_cmd inside [settings] only", () => {
  const got = parseWakaCfg(`
[settings]
api_key_vault_cmd = /usr/bin/security find-generic-password -w
[git]
api_key_vault_cmd = should not leak
`);
  expect(got.api_key_vault_cmd).toBe("/usr/bin/security find-generic-password -w");
});

test("splitVaultCmd: plain words, extra whitespace collapses", () => {
  expect(splitVaultCmd("cmd arg1 arg2")).toEqual(["cmd", "arg1", "arg2"]);
  expect(splitVaultCmd("  cmd   arg1  ")).toEqual(["cmd", "arg1"]);
  expect(splitVaultCmd("")).toEqual([]);
  expect(splitVaultCmd("   ")).toEqual([]);
});

test("splitVaultCmd: single and double quotes group a word with spaces in it", () => {
  expect(splitVaultCmd('cmd "arg with spaces" tail')).toEqual(["cmd", "arg with spaces", "tail"]);
  expect(splitVaultCmd("cmd 'arg with spaces' tail")).toEqual(["cmd", "arg with spaces", "tail"]);
});

test("splitVaultCmd: backslash escapes a literal character, in or out of quotes", () => {
  expect(splitVaultCmd("a\\ b c")).toEqual(["a b", "c"]);
  expect(splitVaultCmd('cmd "a\\"b"')).toEqual(["cmd", 'a"b']);
});

test("splitVaultCmd: an unterminated quote is not fatal", () => {
  expect(() => splitVaultCmd('cmd "unterminated')).not.toThrow();
  expect(splitVaultCmd('cmd "unterminated')).toEqual(["cmd", "unterminated"]);
});

test("splitVaultCmd never throws on garbage input", () => {
  expect(() => splitVaultCmd(null)).not.toThrow();
  expect(() => splitVaultCmd(undefined)).not.toThrow();
  expect(splitVaultCmd(null)).toEqual([]);
});

// Fix round 1 / M-1: a double-quoted word ending in a trailing backslash at
// end-of-string used to concatenate the literal string "undefined"
// (`'"\\$\`'.includes(str[i + 1] ?? "")` -- `includes("")` is always true).
// Reproduced before the fix: `splitVaultCmd('cmd "abc\\')` -> `["cmd",
// "abcundefined"]`. The outside-quotes escape path already guarded this
// (`i + 1 < str.length`); only the in-quote branch was missing it.
test("splitVaultCmd: a trailing backslash inside an unterminated double quote is not 'undefined'", () => {
  expect(splitVaultCmd('cmd "abc\\')).toEqual(["cmd", "abc\\"]);
});

// Fix round 1 / M-1: `/\s/` matches every Unicode space JS considers
// whitespace, including U+00A0 (non-breaking space) -- which a real shell's
// IFS does not treat as a separator. A non-breaking space pasted into a
// vault command's path would silently split one argument into two.
test("splitVaultCmd: only ASCII space/tab/newline/CR separate words, not every Unicode space", () => {
  const nbsp = "cmd" + "\u00a0" + "arg"; // U+00A0, not a plain space
  expect(splitVaultCmd(nbsp)).toEqual(["cmd\u00a0arg"]);
  expect(splitVaultCmd("cmd arg")).toEqual(["cmd", "arg"]); // plain space still separates
});

test("expandTilde: a leading ~ or ~/ resolves against the real home directory, nothing else does", () => {
  expect(expandTilde("~")).toBe(os.homedir());
  expect(expandTilde("~/bin/vault")).toBe(path.join(os.homedir(), "bin/vault"));
  expect(expandTilde("/already/absolute")).toBe("/already/absolute");
  expect(expandTilde("relative/path")).toBe("relative/path");
  // Deliberately not expanded: `~otheruser` needs a passwd lookup this
  // module has no other reason to perform.
  expect(expandTilde("~otheruser/bin")).toBe("~otheruser/bin");
});

// Fix round 2 / D-3: expandTilde is exported, and this file's rule is
// "never throws" for everything in it -- an exported helper is not exempt
// just because splitVaultCmd never actually hands it a non-string.
// Reproduced before the fix: expandTilde(123) threw
// "token.startsWith is not a function".
test("D-3: expandTilde never throws on a non-string, returns it unchanged", () => {
  expect(() => expandTilde(123)).not.toThrow();
  expect(expandTilde(123)).toBe(123);
  expect(expandTilde(null)).toBeNull();
  expect(expandTilde(undefined)).toBeUndefined();
  expect(expandTilde(["~"])).toEqual(["~"]);
});

// Fix round 2 / D-2: quoting or escaping a `~` does NOT suppress expansion
// the way it would in a real shell -- splitVaultCmd's quote removal already
// happened by the time expandTilde sees the token, so `"~"`, `'~'`, and
// `\~` are indistinguishable from a bare `~`. Documented as a deliberate
// limitation (not "shell-faithful" on this one point), not a bug: there is
// no escape sequence that survives to produce a literal `~` in an argument.
test("D-2: quoting or escaping a ~ does not suppress expansion -- there is no way to get a literal ~", () => {
  const home = os.homedir();
  const expand = (cmd) => splitVaultCmd(cmd).map(expandTilde);
  expect(expand("~")).toEqual([home]); // the ordinary unquoted case, for contrast
  expect(expand('"~"')).toEqual([home]);
  expect(expand("'~'")).toEqual([home]);
  expect(expand("\~")).toEqual([home]);
});

test("execVaultCmd returns { key, problem: null } on success, from a real (fake) command", () => {
  const script = writeScript("vault-ok.sh", 'echo "  fake-vault-token-abc123  "');
  expect(execVaultCmd(script)).toEqual({ key: "fake-vault-token-abc123", problem: null });
});

test("execVaultCmd classifies a missing binary distinctly, never throws", () => {
  const missing = path.join(root, "does-not-exist-binary");
  expect(() => execVaultCmd(missing)).not.toThrow();
  expect(execVaultCmd(missing)).toEqual({ key: "", problem: "api_key_vault_cmd: command not found" });
});

test("execVaultCmd classifies a non-zero exit distinctly, and never surfaces stderr in its own return value", () => {
  const script = writeScript("vault-fail.sh", 'echo "leaked-secret-should-not-appear" 1>&2\nexit 7');
  expect(execVaultCmd(script)).toEqual({ key: "", problem: "api_key_vault_cmd: exited 7" });
});

test("execVaultCmd classifies empty stdout distinctly from a hard failure", () => {
  const script = writeScript("vault-empty.sh", "true");
  expect(execVaultCmd(script)).toEqual({ key: "", problem: "api_key_vault_cmd: produced no output" });
});

test("execVaultCmd classifies an empty command string distinctly", () => {
  expect(execVaultCmd("   ")).toEqual({ key: "", problem: "api_key_vault_cmd: empty" });
});

// Fix round 2: a maxBuffer overflow is killed with SIGKILL just like a
// timeout, so without its own check it fell into classifyVaultFailure's
// generic `err.signal` branch and reported "killed by SIGKILL" -- true, but
// pointing at the wrong problem ("the command hung" vs. "the command's
// output was too large" call for different fixes). Reproduced before the
// fix: this exact script classified as "killed by SIGKILL".
test("execVaultCmd classifies output exceeding maxBuffer as too-large, not a generic SIGKILL", () => {
  const script = writeScript("vault-huge-output.sh", "yes A | head -c 2000000");
  expect(execVaultCmd(script)).toEqual({ key: "", problem: "api_key_vault_cmd: output too large" });
});

test("execVaultCmd bounds a hanging command with its timeout, never hangs the caller", () => {
  const script = writeScript("vault-slow.sh", "sleep 2\necho too-late");
  const start = Date.now();
  expect(execVaultCmd(script, { timeoutMs: 100 })).toEqual({ key: "", problem: "api_key_vault_cmd: timed out" });
  // Generous ceiling: proves it did not wait for the 2s sleep, without
  // pinning to a tight number that could flake under CI scheduling jitter.
  expect(Date.now() - start).toBeLessThan(1500);
});

// Fix round 1 / I-2: execFileSync's `timeout` kills with SIGTERM by default,
// which a child that traps or ignores it can simply ride out past the
// deadline. Proven by direct measurement before the fix: this exact script
// took the full ~5s sleep regardless of a 200ms timeoutMs. With `killSignal:
// "SIGKILL"` it is bounded like any other case, because SIGKILL cannot be
// trapped.
test("execVaultCmd kills a child that ignores SIGTERM (SIGKILL, not SIGTERM)", () => {
  const script = writeScript("vault-trap-term.sh", "trap '' TERM\nsleep 5\necho too-late");
  const start = Date.now();
  expect(execVaultCmd(script, { timeoutMs: 200 })).toEqual({ key: "", problem: "api_key_vault_cmd: timed out" });
  expect(Date.now() - start).toBeLessThan(1500);
});

// Fix round 1 / I-3 (the `~` half): a `~`-relative path in
// api_key_vault_cmd is an ordinary thing to write, and before this fix it
// failed with a bare ENOENT indistinguishable from "no key configured."
// Needs a real subprocess with $HOME set at spawn time, not this test's own
// $HOME (see the `runProbe` comment above) -- never the developer's real
// home directory.
test("execVaultCmd expands a leading ~/ to $HOME before executing, not the developer's real home", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-fakehome-"));
  try {
    fs.mkdirSync(path.join(fakeHome, "bin"));
    const script = path.join(fakeHome, "bin", "vault.sh");
    fs.writeFileSync(script, "#!/bin/sh\necho tilde-expanded-secret\n");
    fs.chmodSync(script, 0o755);

    const result = runProbe(
      `const r = execVaultCmd("~/bin/vault.sh"); process.stdout.write(JSON.stringify(r));`,
      { env: { ...process.env, HOME: fakeHome } },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ key: "tilde-expanded-secret", problem: null });
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

// Fix round 1 / I-1: this is the project's named failure shape -- a test
// named "never surfaces stderr" that only asserted the return value, which
// stays "" under *any* stdio configuration. Proven a real regression guard
// by mutation: with `stdio[2]` reverted to `"inherit"`, a probe subprocess's
// own stderr captured the script's leaked secret; with the fix in place, it
// does not. This test observes the actual byte stream a real caller would
// see, from outside the process under test, which the in-process return
// value alone cannot prove.
test("execVaultCmd never lets a failing command's stderr reach the calling process's own stderr", () => {
  const script = writeScript("vault-leak-stderr.sh", 'echo "leaked-secret-should-not-appear" 1>&2\nexit 7');
  const result = runProbe(
    `const r = execVaultCmd(${JSON.stringify(script)}); process.stdout.write(JSON.stringify(r));`,
  );
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({ key: "", problem: "api_key_vault_cmd: exited 7" });
});

test("execVaultCmd never throws even on a malformed command string", () => {
  expect(() => execVaultCmd('"unterminated')).not.toThrow();
  // Tokenises to ["unterminated"] (the opening quote is consumed, not a
  // separate token) -- execFileSync then tries to run a program literally
  // named "unterminated", which does not exist.
  expect(execVaultCmd('"unterminated')).toEqual({ key: "", problem: "api_key_vault_cmd: command not found" });
});

test("loadWakaConfig: vault command sits between cfg.api_key and json.apiKey", () => {
  const cfgPath = writeFile(
    "vault-precedence.cfg",
    "[settings]\napi_key_vault_cmd = /path/to/vault-cmd --get\n",
  );
  const jsonPath = writeFile("vault-precedence.json", JSON.stringify({ apiKey: "from_json" }));

  const runVaultCmd = (cmd) => {
    expect(cmd).toBe("/path/to/vault-cmd --get");
    return { key: "from_vault\n", problem: null }; // realistic: a CLI's stdout often carries a trailing newline
  };
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath, runVaultCmd });
  expect(got.apiKey).toBe("from_vault");
  expect(got.source).toBe("api_key_vault_cmd");
  expect(got.vaultCmdProblem).toBeNull();
});

test("loadWakaConfig: cfg.api_key still wins over api_key_vault_cmd", () => {
  const cfgPath = writeFile(
    "vault-cfg-wins.cfg",
    "[settings]\napi_key = from_cfg\napi_key_vault_cmd = /path/to/vault-cmd\n",
  );
  let called = false;
  const runVaultCmd = () => {
    called = true;
    return { key: "from_vault", problem: null };
  };
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope", runVaultCmd });
  expect(got.apiKey).toBe("from_cfg");
  expect(got.source).toBe(cfgPath);
  expect(called).toBe(false); // cfg.api_key must short-circuit before the command ever runs
});

test("loadWakaConfig: WAKATIME_API_KEY still wins over api_key_vault_cmd", () => {
  const cfgPath = writeFile("vault-env-wins.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  let called = false;
  const runVaultCmd = () => {
    called = true;
    return { key: "from_vault", problem: null };
  };
  const got = loadWakaConfig({ env: { WAKATIME_API_KEY: "from_env" }, cfgPath, jsonPath: "/nope", runVaultCmd });
  expect(got.apiKey).toBe("from_env");
  expect(called).toBe(false);
});

test("loadWakaConfig: a vault command yielding nothing falls through to json.apiKey, and its problem is not surfaced", () => {
  const cfgPath = writeFile("vault-empty-falls-through.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const jsonPath = writeFile("vault-empty-falls-through.json", JSON.stringify({ apiKey: "from_json" }));
  const got = loadWakaConfig({
    env: {},
    cfgPath,
    jsonPath,
    runVaultCmd: () => ({ key: "", problem: "api_key_vault_cmd: command not found" }),
  });
  expect(got.apiKey).toBe("from_json");
  expect(got.source).toBe(jsonPath);
  // json.apiKey rescued the run -- configProblem() only cares about the
  // *outcome* being healthy, so the vault's own failure must not still
  // shadow a working config.
  expect(got.vaultCmdProblem).toBeNull();
  expect(configProblem(got)).toBeNull();
});

test("loadWakaConfig: a vault command's problem string reaches configProblem verbatim when nothing else supplies a key", () => {
  const cfgPath = writeFile("vault-problem-verbatim.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const got = loadWakaConfig({
    env: {},
    cfgPath,
    jsonPath: "/nope",
    runVaultCmd: () => ({ key: "", problem: "api_key_vault_cmd: timed out" }),
  });
  expect(got.apiKey).toBe("");
  expect(got.vaultCmdProblem).toBe("api_key_vault_cmd: timed out");
  expect(configProblem(got)).toBe("api_key_vault_cmd: timed out");
});

test("loadWakaConfig: a vault command that throws is treated as no key, never propagates", () => {
  const cfgPath = writeFile("vault-throws.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const jsonPath = writeFile("vault-throws.json", JSON.stringify({ apiKey: "from_json" }));
  const runVaultCmd = () => {
    throw new Error("boom");
  };
  expect(() => loadWakaConfig({ env: {}, cfgPath, jsonPath, runVaultCmd })).not.toThrow();
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath, runVaultCmd });
  expect(got.apiKey).toBe("from_json");
});

test("loadWakaConfig: a vault command that throws, with no json fallback, gets the generic runner-failed diagnosis", () => {
  const cfgPath = writeFile("vault-throws-no-fallback.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const runVaultCmd = () => {
    throw new Error("boom");
  };
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope", runVaultCmd });
  expect(got.apiKey).toBe("");
  expect(configProblem(got)).toBe("api_key_vault_cmd: runner failed unexpectedly");
});

test("loadWakaConfig: no cfg.api_key, no vault command at all, no json -> the plain generic problem", () => {
  const got = loadWakaConfig({ env: {}, cfgPath: "/nope", jsonPath: "/nope" });
  expect(got.apiKey).toBe("");
  expect(got.vaultCmdProblem).toBeNull();
  expect(configProblem(got)).toBe("no API key configured");
});

// Fix round 1 / I-3 (the diagnosability half): every vault failure used to
// collapse into the same generic "no API key configured" that an empty
// config produces -- including the two failure classes most likely to
// actually happen (this one and the ~-expansion case above). --status is
// this tool's stated antidote to silence; before this fix, it reported the
// wrong illness. These exercise the real pipeline end-to-end (real fake
// scripts, no injected runVaultCmd) so the classification is proven through
// loadWakaConfig and configProblem together, not just at execVaultCmd's own
// boundary.
test("loadWakaConfig + configProblem: a vault command that isn't found is diagnosed distinctly", () => {
  const cfgPath = writeFile("vault-diag-missing.cfg", `[settings]\napi_key_vault_cmd = ${path.join(root, "no-such-vault-binary")}\n`);
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(got.apiKey).toBe("");
  expect(configProblem(got)).toBe("api_key_vault_cmd: command not found");
});

test("loadWakaConfig + configProblem: a vault command that exits non-zero is diagnosed distinctly", () => {
  const script = writeScript("vault-diag-exit.sh", "exit 9");
  const cfgPath = writeFile("vault-diag-exit.cfg", `[settings]\napi_key_vault_cmd = ${script}\n`);
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(configProblem(got)).toBe("api_key_vault_cmd: exited 9");
});

test("loadWakaConfig + configProblem: a vault command with empty output is diagnosed distinctly", () => {
  const script = writeScript("vault-diag-empty.sh", "true");
  const cfgPath = writeFile("vault-diag-empty.cfg", `[settings]\napi_key_vault_cmd = ${script}\n`);
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(configProblem(got)).toBe("api_key_vault_cmd: produced no output");
});

// Not a distinct diagnosis: parseWakaCfg's own `.trim()` collapses a
// whitespace-only value to `""`, which is falsy, so loadWakaConfig never
// even calls the vault runner for it -- it reads exactly like the key being
// absent from the file altogether, same as today. execVaultCmd's own
// "api_key_vault_cmd: empty" classification (tested directly above) only
// fires for a caller that hands it a non-empty-but-all-whitespace string
// directly; through a real cfg file, that string never survives parsing.
test("loadWakaConfig: a whitespace-only api_key_vault_cmd value in the file is the same as it being absent", () => {
  const cfgPath = writeFile("vault-diag-blank.cfg", "[settings]\napi_key_vault_cmd =    \n");
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(got.vaultCmdProblem).toBeNull();
  expect(configProblem(got)).toBe("no API key configured");
});

test("loadWakaConfig end-to-end: a real fake vault script, no injected runVaultCmd", () => {
  const script = writeScript("vault-e2e.sh", 'echo "vault-secret-e2e-001"');
  const cfgPath = writeFile("vault-e2e.cfg", `[settings]\napi_key_vault_cmd = ${script}\n`);
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(got.apiKey).toBe("vault-secret-e2e-001");
  expect(got.source).toBe("api_key_vault_cmd");
  expect(got.vaultCmdProblem).toBeNull();
  expect(configProblem(got)).toBeNull();
});
