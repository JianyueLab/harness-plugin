/**
 * Where to report and with what key.
 *
 * The environment wins over every file, so a shell that already exports
 * `JYL_API_KEY` — the same variable `/setup` hands Claude Code's
 * `apiKeyHelper` — needs no second copy of the secret on disk. Among files, the
 * shared path is checked before the host's own, so one key serves both hosts
 * while an existing `~/.claude/jyl-usage/config.json` keeps working untouched.
 *
 * `baseUrl` is the portal **origin**, not its `…/v1` base: this posts to
 * `<origin>/v1/usage/ingest`, and a value already ending in `/v1` would resolve
 * to `/v1/v1/usage/ingest`. A trailing `/v1` is stripped rather than 404ing an
 * hour later in a log nobody is reading.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHARED_CONFIG_FILE = path.join(os.homedir(), ".config", "jyl-usage", "config.json");

export const configFiles = (hostConfigFile) => [SHARED_CONFIG_FILE, hostConfigFile];

/** Host of a URL, or null when it isn't one. Used to compare origins loosely. */
export function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

function firstFile(files) {
  for (const file of files) {
    try {
      return { file, body: JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      /* absent or unreadable: try the next */
    }
  }
  return { file: null, body: {} };
}

export function loadConfig({ files = [] } = {}) {
  const { file, body } = firstFile(files);
  const rawBase = process.env.JYL_USAGE_BASE_URL || process.env.JYL_LLM_BASE_URL || body.baseUrl || "";
  return {
    source: file,
    baseUrl: rawBase.trim().replace(/\/+$/, "").replace(/\/v1$/, ""),
    apiKey: (process.env.JYL_USAGE_API_KEY || process.env.JYL_API_KEY || body.apiKey || "").trim(),
    enabled: process.env.JYL_USAGE_DISABLED === "1" ? false : body.enabled !== false,
    /**
     * Report even when this Claude Code session is itself pointed at the portal.
     * Off by default: the `/v1` proxy already metered that traffic, and
     * reporting it again would count the same tokens under both sources.
     */
    reportGatewayTraffic: body.reportGatewayTraffic === true,
  };
}

export function configProblem(config) {
  if (!config.enabled) return "disabled";
  if (!config.baseUrl) return "no base URL configured";
  if (!config.apiKey) return "no API key configured";
  if (!hostOf(config.baseUrl)) return `base URL is not a URL: ${config.baseUrl}`;
  return null;
}

export function redactKey(key) {
  if (!key) return "(unset)";
  return key.length <= 8 ? "…" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
