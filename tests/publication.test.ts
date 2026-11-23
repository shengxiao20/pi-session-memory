import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }));
const paths: string[] = pack.files.map((file: { path: string }) => file.path);
assert.equal(pack.version, manifest.version);
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
for (const declared of manifest.files as string[]) {
  const source = resolve(declared);
  assert.ok(existsSync(source), `every declared publication resource exists: ${declared}`);
  assert.ok(statSync(source).isDirectory() ? paths.some(path => path.startsWith(declared)) : paths.includes(declared), `every declared publication resource is actually packaged: ${declared}`);
}
for (const required of ["extensions/index.ts", "src/presentation/database-session-management.ts", "src/setup/config-editor.ts", "src/setup/config-fields.ts", "src/setup/setup-schema.ts", "src/settings/config.ts", "README.md", "prompts/README.md", "prompts/setup.md", "prompts/tools.ts", "prompts/parameters.ts", "prompts/guidance.ts", "prompts/configuration.ts", "prompts/models.ts", "prompts/responses.ts", "CHANGELOG.md", "site/assets/codegraph-map.json", "site/assets/codegraph-map.svg"]) assert.ok(paths.includes(required), `published feature resource: ${required}`);
assert.ok(!paths.some(path => /^(?:docs|tests|scripts|experiments)\//.test(path)), "retired resources, tests and independent demos stay outside the package");
assert.ok(!paths.some(path => /entity-architecture|\.sqlite(?:$|-)|\.db(?:$|-)|\.jsonl$/.test(path)), "retired figure and local history are not published");
assert.deepEqual(manifest.pi.prompts, [], "packaged internal Markdown is excluded from Pi prompt discovery");
assert.ok(!paths.includes("setup.md"), "the setup guide has one canonical packaged location");
for (const document of ["README.md", "prompts/setup.md", "prompts/README.md"]) {
  const text = readFileSync(document, "utf8");
  for (const [, target] of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    if (/^(?:https?:|#)/.test(target)) continue;
    const source = resolve(dirname(document), target.split("#")[0]);
    assert.ok(existsSync(source), `${document} local link exists: ${target}`);
  }
}
assert.ok(!existsSync("docs"), "retired documentation is not restored");
console.log(`publication tests passed: ${pack.version}, ${paths.length} files, all declared resources present, no retired resources or demo files, local documentation links valid`);
