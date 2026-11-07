import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(root, "src");
const allowedDependencies: Record<string, readonly string[]> = {
  contracts: [],
  history: [],
  settings: [],
  relevance: ["contracts", "settings"],
  recall: ["contracts", "history", "relevance", "settings"],
  knowledge: ["contracts", "settings"],
  presentation: ["contracts", "knowledge", "settings"],
  consultation: ["contracts", "history", "knowledge", "presentation", "settings"],
  setup: ["knowledge", "settings"],
};
const domains = readdirSync(sourceRoot, { withFileTypes: true });
assert.ok(domains.every(entry => entry.isDirectory()), "src contains domain directories, not flat source files");
assert.deepEqual(domains.map(entry => entry.name).sort(), Object.keys(allowedDependencies).sort());

const sources = domains.flatMap(domain => {
  const directory = join(sourceRoot, domain.name);
  const files = readdirSync(directory, { withFileTypes: true });
  assert.ok(files.length > 0, `${domain.name} owns source modules`);
  assert.ok(files.every(entry => entry.isFile() && entry.name.endsWith(".ts")), `${domain.name} contains TypeScript modules only`);
  return files.map(entry => join(directory, entry.name));
});
const entryPoint = join(root, "extensions", "index.ts");
const graph = new Map<string, string[]>();
for (const source of [...sources, entryPoint]) {
  const text = readFileSync(source, "utf8");
  const sourceDomain = relative(sourceRoot, source).split(/[\\/]/)[0];
  if (sourceDomain === "contracts") {
    assert.doesNotMatch(text, /^import (?!type\b)|^export (?:const|let|var|class|function|enum)\b/m, "contracts contain types only");
  }
  const targets = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\()\s*["'](\.[^"']+\.ts)["']/g)].map(match => {
    const target = resolve(dirname(source), match[1]);
    assert.ok(statSync(target).isFile(), `import target exists: ${relative(root, source)} → ${match[1]}`);
    assert.ok(sources.includes(target), `internal imports target a domain module: ${match[1]}`);
    const targetDomain = relative(sourceRoot, target).split(/[\\/]/)[0];
    if (source !== entryPoint && sourceDomain !== targetDomain) {
      assert.ok(allowedDependencies[sourceDomain].includes(targetDomain), `allowed domain dependency: ${sourceDomain} → ${targetDomain}`);
    }
    return target;
  });
  graph.set(source, targets);
}

const visited = new Set<string>();
function visit(source: string, path: string[]): void {
  assert.ok(!path.includes(source), `dependency cycle: ${[...path, source].map(file => relative(root, file)).join(" → ")}`);
  if (visited.has(source)) return;
  const targets = graph.get(source);
  assert.ok(targets, `module belongs to the dependency graph: ${source}`);
  for (const target of targets) visit(target, [...path, source]);
  visited.add(source);
}
for (const source of graph.keys()) visit(source, []);

const mapSnapshot = JSON.parse(readFileSync(join(root, "site/assets/codegraph-map.json"), "utf8")) as {
  source: { tool: string; root: string; depth: number; sourceFiles: number; moduleCycles: number };
  modules: Array<{ id: string; files: number }>;
  links: Array<{ source: string; target: string; declared: number }>;
  reviewedDynamicImports: Array<{ source: string; target: string; file: string; specifier: string }>;
};
const mapSvg = readFileSync(join(root, "site/assets/codegraph-map.svg"), "utf8");
function moduleId(file: string): string {
  return file === entryPoint ? "extensions/index.ts" : `src/${relative(sourceRoot, file).split(/[\\/]/)[0]}`;
}
const moduleFiles = new Map<string, number>();
for (const source of graph.keys()) {
  const id = moduleId(source);
  moduleFiles.set(id, (moduleFiles.get(id) ?? 0) + 1);
}
assert.equal(mapSnapshot.source.tool, "CodeGraph Map");
assert.equal(mapSnapshot.source.root, "");
assert.equal(mapSnapshot.source.depth, 2);
assert.equal(mapSnapshot.source.sourceFiles, sources.length);
assert.equal(mapSnapshot.source.moduleCycles, 0);
assert.deepEqual(mapSnapshot.modules.map(module => [module.id, module.files]).sort(), [...moduleFiles].sort(), "Map module counts match current source files");
const actualLinks = new Set<string>();
for (const [source, targets] of graph) {
  for (const target of targets) {
    if (moduleId(source) !== moduleId(target)) actualLinks.add(`${moduleId(source)} → ${moduleId(target)}`);
  }
}
const snapshotLinks = [...mapSnapshot.links, ...mapSnapshot.reviewedDynamicImports];
const snapshotLinkIds = snapshotLinks.map(link => `${link.source} → ${link.target}`);
assert.equal(snapshotLinkIds.length, new Set(snapshotLinkIds).size, "Map has no duplicate domain relationships");
assert.deepEqual(snapshotLinkIds.sort(), [...actualLinks].sort(), "Map declared links plus reviewed dynamic imports match current cross-domain imports");
for (const link of mapSnapshot.links) assert.ok(link.declared > 0, "Map excludes unresolved guesses");
for (const link of mapSnapshot.reviewedDynamicImports) {
  const file = join(root, link.file);
  assert.equal(moduleId(file), link.source);
  assert.equal(moduleId(resolve(dirname(file), link.specifier)), link.target);
  assert.ok(readFileSync(file, "utf8").includes(`import("${link.specifier}")`), "reviewed dynamic import remains in source");
}
const svgModules = [...mapSvg.matchAll(/<g data-module="([^"]+)" data-files="(\d+)" data-dependencies="([^"]*)">([\s\S]*?)<\/g>/g)];
assert.deepEqual(svgModules.map(match => [match[1], Number(match[2])]).sort(), mapSnapshot.modules.map(module => [module.id, module.files]).sort(), "SVG includes every Map module with the correct file count");
for (const [, id, , dependencies, content] of svgModules) {
  const expected = snapshotLinks.filter(link => link.source === id).map(link => link.target.replace("src/", "")).sort();
  assert.equal(dependencies, expected.join(" "), `SVG dependency metadata matches snapshot: ${id}`);
  if (id !== "extensions/index.ts") {
    for (const dependency of expected) assert.ok(content.includes(dependency), `SVG card visibly lists ${id} → ${dependency}`);
  }
}
for (const [, source, target] of mapSvg.matchAll(/data-source="([^"]+)" data-target="([^"]+)"/g)) {
  assert.ok(actualLinks.has(`${source} → ${target}`), `SVG arrow has source evidence: ${source} → ${target}`);
}
assert.match(mapSvg, /not a runtime trace/);
assert.match(mapSvg, /Type-only dependency/);
assert.match(mapSvg, /Source-verified dynamic import/);

const config = JSON.parse(readFileSync(join(root, "codegraph.json"), "utf8"));
assert.deepEqual(config, { exclude: [".github/", "scripts/", "site/", "sites/"] }, "CodeGraph excludes auxiliary directories, not tests or runtime modules");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
assert.deepEqual(manifest.pi.extensions, ["./extensions"], "the public Pi entry point remains unchanged");
assert.ok(manifest.files.includes("src/"), "all domain modules are packaged");
assert.ok(manifest.files.includes("docs/architecture.md"), "the architecture guide is packaged");
assert.ok(manifest.files.includes("site/assets/codegraph-map.svg"), "the shared README architecture image is packaged");
assert.ok(manifest.files.includes("site/assets/codegraph-map.json"), "the architecture evidence snapshot is packaged");
console.log("architecture.test.ts: passed");
