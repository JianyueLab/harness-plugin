import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_API_URL,
  configProblem,
  loadWakaConfig,
  parseWakaCfg,
  redactKey,
} from "../src/wakatime/cfg.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-waka-cfg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const writeFile = (name, body) => {
  const p = path.join(root, name);
  fs.writeFileSync(p, body);
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
