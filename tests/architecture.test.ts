import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

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
const mappedSources = [...sources, entryPoint];
const promptRoot = join(root, "prompts");
const promptEntries = readdirSync(promptRoot, { withFileTypes: true });
assert.ok(promptEntries.every(entry => entry.isFile() && /\.(?:ts|md)$/.test(entry.name)), "prompts contains text resources only");
const promptSources = promptEntries.filter(entry => entry.name.endsWith(".ts")).map(entry => join(promptRoot, entry.name));
assert.equal(promptSources.length, 6, "six focused prompt modules are covered by dependency checks");
const allSources = [...mappedSources, ...promptSources];
function analyzeSource(text: string, filename: string) {
  const ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  let hasControlFlow = false;
  function visitNode(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      assert.ok(ts.isStringLiteral(node.moduleSpecifier), "module specifiers are string literals");
      imports.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      assert.equal(node.arguments.length, 1, "dynamic imports have one explicit module specifier");
      assert.ok(ts.isStringLiteral(node.arguments[0]), "dynamic imports use literal module paths");
      imports.push(node.arguments[0].text);
    }
    hasControlFlow ||= ts.isIfStatement(node) || ts.isSwitchStatement(node)
      || ts.isTryStatement(node) || ts.isThrowStatement(node) || ts.isAwaitExpression(node);
    ts.forEachChild(node, visitNode);
  }
  visitNode(ast);
  return { imports, hasControlFlow };
}
assert.deepEqual(analyzeSource('export const note = "Copy from " + "a file. if (needed), throw(error).";', "probe.ts"),
  { imports: [], hasControlFlow: false }, "text is not an import or runtime control flow");
assert.deepEqual(analyzeSource('import x from "node:fs"; export { y } from "./shared.ts"; const z = import("./dynamic.ts");', "probe.ts").imports,
  ["node:fs", "./shared.ts", "./dynamic.ts"], "static imports, re-exports and dynamic imports remain checked");
for (const code of ['if (true) {}', 'switch (x) {}', 'try {} catch {}', 'throw new Error();', 'await task();']) {
  assert.equal(analyzeSource(code, "probe.ts").hasControlFlow, true, "real control flow remains rejected");
}
const graph = new Map<string, string[]>();
for (const source of allSources) {
  const text = readFileSync(source, "utf8");
  const sourceDomain = relative(sourceRoot, source).split(/[\\/]/)[0];
  if (sourceDomain === "contracts") {
    assert.doesNotMatch(text, /^import (?!type\b)|^export (?:const|let|var|class|function|enum)\b/m, "contracts contain types only");
  }
  const analysis = analyzeSource(text, source);
  const targets = analysis.imports.filter(specifier => specifier.startsWith(".") && specifier.endsWith(".ts")).map(specifier => {
    const target = resolve(dirname(source), specifier);
    assert.ok(statSync(target).isFile(), `import target exists: ${relative(root, source)} → ${specifier}`);
    assert.ok(allSources.includes(target), `internal imports target a source or prompt module: ${specifier}`);
    const targetDomain = relative(sourceRoot, target).split(/[\\/]/)[0];
    if (promptSources.includes(source)) {
      assert.ok(promptSources.includes(target), "prompt resources must not import runtime modules");
    } else if (promptSources.includes(target)) {
      assert.notEqual(sourceDomain, "contracts", "type-only contracts must not import prompt values");
    } else if (source !== entryPoint && sourceDomain !== targetDomain) {
      assert.ok(allowedDependencies[sourceDomain].includes(targetDomain), `allowed domain dependency: ${sourceDomain} → ${targetDomain}`);
    }
    return target;
  });
  if (promptSources.includes(source)) {
    assert.ok(analysis.imports.every(specifier => specifier.startsWith("./") && specifier.endsWith(".ts")), "prompt modules have no external, filesystem or service dependencies");
    assert.equal(analysis.hasControlFlow, false, "prompt modules format text without runtime control flow");
  }
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
for (const source of mappedSources) {
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
    if (mappedSources.includes(source) && mappedSources.includes(target) && moduleId(source) !== moduleId(target)) actualLinks.add(`${moduleId(source)} → ${moduleId(target)}`);
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
assert.ok(manifest.files.includes("prompts/"), "all shared text resources are packaged");
assert.deepEqual(manifest.pi.prompts, [], "internal Markdown resources are not registered as Pi slash commands");
assert.ok(!manifest.files.some((path: string) => path.startsWith("docs/")), "retired documentation is not declared for publication");
assert.ok(manifest.files.includes("site/assets/codegraph-map.svg"), "the shared README architecture image is packaged");
assert.ok(manifest.files.includes("site/assets/codegraph-map.json"), "the architecture evidence snapshot is packaged");
console.log("architecture.test.ts: passed");
