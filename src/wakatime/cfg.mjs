/**
 * Where to send heartbeats and with what key.
 *
 * Reading `~/.wakatime.cfg` is the whole point, not a convenience: anyone who
 * has ever installed a WakaTime editor plugin already has a key there, and
 * asking for a second copy of a secret is asking for it to rot.
 *
 * `api_url` matters as much as the key — self-hosted wakapi and hakatime are
 * common, and hardcoding wakatime.com locks those users out.
 *
 * Only `[settings]` is parsed, and only four keys out of it: `api_key`,
 * `api_key_vault_cmd`, `api_url`, and `hide_file_names`. `exclude`, `include`,
 * `proxy` and the rest are wakatime-cli's business; a parser that threw on an
 * unfamiliar line would break on WakaTime's next release.
 *
 * `api_key_vault_cmd` is wakatime-cli's escape hatch for people who keep
 * their key in a password manager instead of in plaintext: instead of
 * `api_key`, the config names a command whose stdout *is* the key. Skipping
 * it was the actual gap this file shipped with — the primary user's own
 * `~/.wakatime.cfg` has no `api_key` at all, only this, so the tool ran
 * forever without ever finding a key. See `execVaultCmd` below for how it is
 * run and everything that has to go right for that to stay safe.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
export const WAKA_CFG_FILE = path.join(os.homedir(), ".wakatime.cfg");
export const JSON_CONFIG_FILE = path.join(os.homedir(), ".config", "jyl-wakatime", "config.json");
// This is the single source of truth for where this tool's state lives.
// `scripts/wakatime` recomputes this exact path in shell (`$HOME/.config/jyl-wakatime`)
// for the one case this module can't run at all -- no bun or no node on
// PATH -- so it can still leave a trace of that failure. Deliberately not
// XDG_CONFIG_HOME-aware: os.homedir() never reads it either, and the shell
// fallback has to match this constant byte-for-byte or its log line lands
// somewhere `--status` never looks (see scripts/wakatime's own comment on
// the same line). Move both together if this ever changes.
export const STATE_DIR = path.join(os.homedir(), ".config", "jyl-wakatime");

/** Parse the `[settings]` section of a wakatime.cfg. Never throws. */
export function parseWakaCfg(text) {
  const KNOWN = new Set(["api_key", "api_key_vault_cmd", "api_url", "hide_file_names"]);
  const out = {};
  let inSettings = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inSettings = line.toLowerCase() === "[settings]";
      continue;
    }
    if (!inSettings) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue; // continuation line of a multi-line value: not ours
    const key = line.slice(0, eq).trim();
    if (!KNOWN.has(key)) continue;
    out[key] = line.slice(eq + 1).trim();
  }
  return out;
}

function readCfg(file) {
  try {
    return parseWakaCfg(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readJson(file) {
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

const trimUrl = (u) => String(u ?? "").trim().replace(/\/+$/, "");

/**
 * Split a command string into argv the way a shell would tokenize it,
 * without invoking one: whitespace-separated words, `'single'` and
 * `"double"` quoting (with `\"`, `\\`, `\$`, `` \` `` recognised inside
 * double quotes, matching POSIX), and a bare `\x` escape outside quotes.
 * No pipes, no `;`/`&&`, no `$VAR` or `$(...)` expansion, no redirection --
 * none of that is interpreted at all, it just ends up as literal characters
 * in a word. Never throws; an unterminated quote is not fatal, it just
 * swallows the rest of the string into that word.
 *
 * This mirrors wakatime-cli's own documented behaviour for
 * `api_key_vault_cmd` (shell-style split, executed without a shell) rather
 * than shelling out to `/bin/sh -c`. The real config this was built against
 * only ever needed two bare words -- checked on the machine that filed this
 * gap, without ever printing the value -- so a shell's extra power (pipes,
 * expansion) buys nothing there, while running one would turn a config file
 * value into an arbitrary-command injection surface on every hook run.
 */
export function splitVaultCmd(command) {
  const out = [];
  const str = String(command ?? "");
  let cur = "";
  let has = false;
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quote) {
      if (c === quote) {
        quote = null;
      } else if (quote === '"' && c === "\\" && '"\\$`'.includes(str[i + 1] ?? "")) {
        cur += str[++i];
      } else {
        cur += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < str.length) {
      cur += str[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

// The hook path calls this synchronously, so it needs a hard ceiling: a vault
// command that hangs (a password-manager daemon that never answers, a locked
// keychain waiting on a prompt nothing will ever click) must not hang the
// hook with it. 5s is generous enough for a real vault CLI's cold start
// (spawning a helper process, unlocking a local keychain) while still coming
// in well under harness's own default 10s hook timeout mentioned in
// send.mjs, so a slow vault command fails this tool's own step instead of
// getting killed mid-run by harness first.
const VAULT_CMD_TIMEOUT_MS = 5_000;

/**
 * Run `api_key_vault_cmd` and return its stdout, trimmed, or `""` on any
 * failure at all -- missing binary, non-zero exit, timeout, empty output.
 * Never throws: a bad vault command must read exactly like no key
 * configured, never like a crash.
 *
 * stderr is discarded, not captured -- a vault command that fails is exactly
 * the kind of thing that might echo the key, or a passphrase prompt, or
 * other secret-shaped text to stderr on its way out, and none of that may
 * ever reach this tool's log ("never log the key" is absolute, and stderr
 * from a command whose whole job is producing a secret is close enough to
 * the key itself to get the same treatment).
 */
export function execVaultCmd(command, { timeoutMs = VAULT_CMD_TIMEOUT_MS } = {}) {
  const argv = splitVaultCmd(command);
  if (argv.length === 0) return "";
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return "";
  }
}

export function loadWakaConfig({
  env = process.env,
  cfgPath = WAKA_CFG_FILE,
  jsonPath = JSON_CONFIG_FILE,
  runVaultCmd = execVaultCmd,
} = {}) {
  const cfg = readCfg(cfgPath);
  const json = readJson(jsonPath);

  let source = null;
  let apiKey = String(env.WAKATIME_API_KEY ?? "").trim();
  if (apiKey) source = "WAKATIME_API_KEY";
  if (!apiKey && cfg.api_key) { apiKey = cfg.api_key.trim(); source = cfgPath; }
  if (!apiKey && cfg.api_key_vault_cmd) {
    // Belt-and-suspenders on top of execVaultCmd's own try/catch: whatever
    // runs here (real or test-injected) must never be able to make config
    // loading -- and therefore the whole hook -- throw.
    let fromVault = "";
    try {
      fromVault = String(runVaultCmd(cfg.api_key_vault_cmd) ?? "").trim();
    } catch {
      fromVault = "";
    }
    if (fromVault) {
      apiKey = fromVault;
      // Deliberately not `cfgPath` (that's what plain `api_key` reports) and
      // deliberately not the command text itself -- the command string can
      // name an account, a vault path, or other specifics that don't need to
      // end up in a status line just to say "this came from the vault
      // command, not the file directly."
      source = "api_key_vault_cmd";
    }
  }
  if (!apiKey && json.apiKey) { apiKey = String(json.apiKey).trim(); source = jsonPath; }

  const apiUrl =
    trimUrl(env.WAKATIME_API_URL) || trimUrl(cfg.api_url) || trimUrl(json.apiUrl) || DEFAULT_API_URL;

  return {
    apiKey,
    apiUrl,
    source,
    hideFileNames: String(cfg.hide_file_names ?? json.hideFileNames ?? "").toLowerCase() === "true",
    enabled: env.JYL_WAKATIME_DISABLED === "1" ? false : json.enabled !== false,
  };
}

export function configProblem(cfg) {
  if (!cfg.enabled) return "disabled";
  if (!cfg.apiKey) return "no API key configured";
  try {
    new URL(cfg.apiUrl);
  } catch {
    return `api url is not a URL: ${cfg.apiUrl}`;
  }
  return null;
}

export function redactKey(key) {
  if (!key) return "(unset)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
