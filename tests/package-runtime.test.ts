import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "pi-package-runtime-"));
try {
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temporary], { cwd: root, encoding: "utf8" }));
  execFileSync("tar", ["-xzf", join(temporary, pack.filename), "-C", temporary]);
  const installed = join(temporary, "package");
  symlinkSync(resolve(root, "node_modules"), join(installed, "node_modules"), "dir");
  const importExtension = `const { default: extension } = await import(${JSON.stringify(pathToFileURL(join(installed, "extensions/index.ts")).href)});`;
  const importSetup = `const { readMemorySetup } = await import(${JSON.stringify(pathToFileURL(join(installed, "src/setup/setup.ts")).href)});`;
  function runInstalled(script: string) {
    const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], {
      cwd: installed, encoding: "utf8", env: { ...process.env, HOME: join(temporary, "home"), USERPROFILE: join(temporary, "home"), MEMORY_DB_PATH: join(temporary, "unused.db") },
    });
    assert.equal(result.error, undefined);
    return result;
  }
  const imported = runInstalled(`${importExtension}${importSetup}
    extension({on() {}, registerTool() {}, registerCommand() {}});
    console.log(JSON.stringify({configuration:readMemorySetup().configuration}));`);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).configuration, null);
  assert.ok(!existsSync(join(temporary, "unused.db")) && !existsSync(join(temporary, "home")), "import and read-only setup create no history or configuration");
  rmSync(join(installed, "prompts/setup.md"));
  const missingGuide = runInstalled(`${importSetup}readMemorySetup();`);
  assert.notEqual(missingGuide.status, 0, "missing Markdown must fail");
  rmSync(join(installed, "prompts/tools.ts"));
  const missingModule = runInstalled(importExtension);
  assert.notEqual(missingModule.status, 0, "missing static prompt module must fail");
  console.log("package runtime tests passed: installed imports, read-only setup and missing-resource failures");
} finally { rmSync(temporary, { recursive: true, force: true }); }
