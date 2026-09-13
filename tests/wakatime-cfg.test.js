import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_API_URL,
  configProblem,
  execVaultCmd,
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

test("execVaultCmd returns trimmed stdout from a real (fake) command", () => {
  const script = writeScript("vault-ok.sh", 'echo "  fake-vault-token-abc123  "');
  expect(execVaultCmd(script)).toBe("fake-vault-token-abc123");
});

test("execVaultCmd treats a missing binary as no key, never throws", () => {
  const missing = path.join(root, "does-not-exist-binary");
  expect(() => execVaultCmd(missing)).not.toThrow();
  expect(execVaultCmd(missing)).toBe("");
});

test("execVaultCmd treats a non-zero exit as no key, and never surfaces stderr", () => {
  const script = writeScript("vault-fail.sh", 'echo "leaked-secret-should-not-appear" 1>&2\nexit 7');
  expect(execVaultCmd(script)).toBe("");
});

test("execVaultCmd treats empty stdout as no key", () => {
  const script = writeScript("vault-empty.sh", "true");
  expect(execVaultCmd(script)).toBe("");
});

test("execVaultCmd bounds a hanging command with its timeout, never hangs the caller", () => {
  const script = writeScript("vault-slow.sh", "sleep 2\necho too-late");
  const start = Date.now();
  expect(execVaultCmd(script, { timeoutMs: 100 })).toBe("");
  // Generous ceiling: proves it did not wait for the 2s sleep, without
  // pinning to a tight number that could flake under CI scheduling jitter.
  expect(Date.now() - start).toBeLessThan(1500);
});

test("execVaultCmd never throws even on a malformed command string", () => {
  expect(() => execVaultCmd('"unterminated')).not.toThrow();
  expect(execVaultCmd('"unterminated')).toBe("");
});

test("loadWakaConfig: vault command sits between cfg.api_key and json.apiKey", () => {
  const cfgPath = writeFile(
    "vault-precedence.cfg",
    "[settings]\napi_key_vault_cmd = /path/to/vault-cmd --get\n",
  );
  const jsonPath = writeFile("vault-precedence.json", JSON.stringify({ apiKey: "from_json" }));

  const runVaultCmd = (cmd) => {
    expect(cmd).toBe("/path/to/vault-cmd --get");
    return "from_vault\n"; // realistic: a CLI's stdout often carries a trailing newline
  };
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath, runVaultCmd });
  expect(got.apiKey).toBe("from_vault");
  expect(got.source).toBe("api_key_vault_cmd");
});

test("loadWakaConfig: cfg.api_key still wins over api_key_vault_cmd", () => {
  const cfgPath = writeFile(
    "vault-cfg-wins.cfg",
    "[settings]\napi_key = from_cfg\napi_key_vault_cmd = /path/to/vault-cmd\n",
  );
  let called = false;
  const runVaultCmd = () => {
    called = true;
    return "from_vault";
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
    return "from_vault";
  };
  const got = loadWakaConfig({ env: { WAKATIME_API_KEY: "from_env" }, cfgPath, jsonPath: "/nope", runVaultCmd });
  expect(got.apiKey).toBe("from_env");
  expect(called).toBe(false);
});

test("loadWakaConfig: a vault command yielding nothing falls through to json.apiKey", () => {
  const cfgPath = writeFile("vault-empty-falls-through.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const jsonPath = writeFile("vault-empty-falls-through.json", JSON.stringify({ apiKey: "from_json" }));
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath, runVaultCmd: () => "" });
  expect(got.apiKey).toBe("from_json");
  expect(got.source).toBe(jsonPath);
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

test("loadWakaConfig: no cfg.api_key, no vault command, no json -> clean 'no API key' problem", () => {
  const cfgPath = writeFile("vault-none.cfg", "[settings]\napi_key_vault_cmd = /path/to/vault-cmd\n");
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope", runVaultCmd: () => "" });
  expect(got.apiKey).toBe("");
  expect(configProblem(got)).toBe("no API key configured");
});

test("loadWakaConfig end-to-end: a real fake vault script, no injected runVaultCmd", () => {
  const script = writeScript("vault-e2e.sh", 'echo "vault-secret-e2e-001"');
  const cfgPath = writeFile("vault-e2e.cfg", `[settings]\napi_key_vault_cmd = ${script}\n`);
  const got = loadWakaConfig({ env: {}, cfgPath, jsonPath: "/nope" });
  expect(got.apiKey).toBe("vault-secret-e2e-001");
  expect(got.source).toBe("api_key_vault_cmd");
  expect(configProblem(got)).toBeNull();
});
