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
 * Only `[settings]` is parsed, and only three keys out of it: `api_key`,
 * `api_url`, and `hide_file_names`. `exclude`, `include`, `proxy` and the rest
 * are wakatime-cli's business; a parser that threw on an unfamiliar line would
 * break on WakaTime's next release.
 */
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
  const KNOWN = new Set(["api_key", "api_url", "hide_file_names"]);
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

export function loadWakaConfig({ env = process.env, cfgPath = WAKA_CFG_FILE, jsonPath = JSON_CONFIG_FILE } = {}) {
  const cfg = readCfg(cfgPath);
  const json = readJson(jsonPath);

  let source = null;
  let apiKey = String(env.WAKATIME_API_KEY ?? "").trim();
  if (apiKey) source = "WAKATIME_API_KEY";
  if (!apiKey && cfg.api_key) { apiKey = cfg.api_key.trim(); source = cfgPath; }
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
