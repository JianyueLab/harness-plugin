import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { loadWakaConfig, configProblem } from "../src/wakatime/cfg.mjs";
import { heartbeatsFrom } from "../src/wakatime/heartbeats.mjs";

const scratch = path.resolve(import.meta.dir, "../.temp");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "wakatime-privacy-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
test("HP-005: multiline path privacy hides matching files and their branch", () => {
  const cfgPath = write(path.join(root, "privacy.cfg"), "[settings]\napi_key = test\nhide_file_names =\n    .*private.*\n    .*sensitive.*\n");
  const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
  const beats = heartbeatsFrom({ tools: [{ name: "read_file", path: "/synthetic/private/file.ts", at: 1 }, { name: "read_file", path: "/synthetic/public/file.ts", at: 2 }], usage: {} }, { ...config, project: "synthetic", branch: "synthetic-branch" });
  expect(beats[0].entity).toBe("HIDDEN.ts");
  expect(beats[0].branch).toBeUndefined();
  expect(beats[1].entity).toBe("/synthetic/public/file.ts");
  expect(beats[1].branch).toBe("synthetic-branch");
});

test("HP-005: invalid privacy configuration blocks transmission, booleans retain meaning", () => {
  for (const value of ["[", "maybe"]) {
    const cfgPath = write(path.join(root, `invalid-privacy-${value.length}.cfg`), `[settings]\napi_key = test\nhide_file_names = ${value}\n`);
    const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
    expect(configProblem(config)).not.toBeNull();
  }
  for (const [raw, hidden] of [["true", true], ["false", false]]) {
    const cfgPath = write(path.join(root, `privacy-${raw}.cfg`), `[settings]\napi_key = test\nhide_file_names = ${raw}\n`);
    const config = loadWakaConfig({ env: {}, cfgPath, jsonPath: path.join(root, "absent.json") });
    const beats = heartbeatsFrom({ tools: [{ name: "read_file", path: "/synthetic/file.ts", at: 1 }] }, config);
    expect(beats[0].entity).toBe(hidden ? "HIDDEN.ts" : "/synthetic/file.ts");
  }
});
