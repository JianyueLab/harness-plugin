import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configProblem, loadConfig, redactKey } from "../src/core/config.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jyl-config-"));
const write = (name, body) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

afterEach(() => {
  delete process.env.JYL_USAGE_BASE_URL;
  delete process.env.JYL_API_KEY;
  delete process.env.JYL_USAGE_DISABLED;
});

test("the environment beats every file", () => {
  const file = write("a.json", { baseUrl: "https://file.example", apiKey: "jyl-file" });
  process.env.JYL_USAGE_BASE_URL = "https://env.example";
  process.env.JYL_API_KEY = "jyl-env";

  const config = loadConfig({ files: [file] });

  expect(config.baseUrl).toBe("https://env.example");
  expect(config.apiKey).toBe("jyl-env");
});

test("the first file that exists wins", () => {
  const shared = write("shared.json", { baseUrl: "https://shared.example", apiKey: "jyl-shared" });
  const legacy = write("legacy.json", { baseUrl: "https://legacy.example", apiKey: "jyl-legacy" });

  expect(loadConfig({ files: [path.join(dir, "absent.json"), shared, legacy] }).baseUrl)
    .toBe("https://shared.example");
});

test("falls back to the legacy file when the shared one is absent", () => {
  const legacy = write("legacy2.json", { baseUrl: "https://legacy.example", apiKey: "jyl-legacy" });
  expect(loadConfig({ files: [path.join(dir, "absent.json"), legacy] }).apiKey).toBe("jyl-legacy");
});

test("strips a trailing /v1 from the origin", () => {
  const file = write("v1.json", { baseUrl: "https://llm.jianyuelab.net/v1/", apiKey: "jyl-x" });
  expect(loadConfig({ files: [file] }).baseUrl).toBe("https://llm.jianyuelab.net");
});

test("names the problem when it cannot report", () => {
  expect(configProblem({ enabled: false })).toBe("disabled");
  expect(configProblem({ enabled: true, baseUrl: "", apiKey: "k" })).toBe("no base URL configured");
  expect(configProblem({ enabled: true, baseUrl: "https://a.example", apiKey: "" })).toBe("no API key configured");
  expect(configProblem({ enabled: true, baseUrl: "https://a.example", apiKey: "k" })).toBeNull();
});

test("redacts the key for display", () => {
  expect(redactKey("jyl-abcdefghijkl")).toBe("jyl-…ijkl");
  expect(redactKey("")).toBe("(unset)");
});
