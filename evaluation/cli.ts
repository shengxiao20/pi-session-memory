import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { datasetPath, modelIdentity, readConfig, resolveModel, requiredEnv } from "./config.ts";
import { LOCOMO_SOURCE, parseDataset, readDataset, sha256, historyTurns } from "./dataset.ts";
import { PROMPTS } from "./models.ts";
import { summarize, type QuestionResult } from "./metrics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = join(ROOT, "evaluation", "runs");
const DATA = join(ROOT, "evaluation", "data");

function _safeDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
  assert.equal(realpathSync(path), path, "Evaluation directories must use real paths without symlinks");
}

function _sourceHashes(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return Object.entries(_sourceHashes(path));
    return /\.(?:ts|mjs|json)$/.test(entry.name) ? [[relative(ROOT, path), sha256(readFileSync(path))]] : [];
  }));
}

async function _download(): Promise<void> {
  _safeDirectory(DATA);
  const destination = join(DATA, "locomo10.json");
  assert(!existsSync(destination), "Dataset already exists; use doctor to verify it");
  const response = await fetch(`https://api.github.com/repos/snap-research/locomo/git/blobs/${LOCOMO_SOURCE.blob}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-session-memory-evaluation" }, signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  assert(response.ok, `LoCoMo download HTTP ${response.status}: ${text}`);
  const blob = JSON.parse(text);
  assert.equal(blob.encoding, "base64");
  assert.equal(blob.sha, LOCOMO_SOURCE.blob);
  assert(typeof blob.content === "string");
  const bytes = Buffer.from(blob.content, "base64");
  assert.equal(sha256(bytes), LOCOMO_SOURCE.sha256, "LoCoMo checksum mismatch");
  const samples = parseDataset(JSON.parse(bytes.toString("utf8")));
  assert.equal(samples.length, 10);
  writeFileSync(destination, bytes, { flag: "wx" });
  writeFileSync(join(DATA, "source.json"), JSON.stringify(LOCOMO_SOURCE, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ dataset: destination, samples: samples.length, source: LOCOMO_SOURCE }, null, 2));
}

function _doctor(configPath: string): void {
  const config = readConfig(configPath);
  const dataset = readDataset(datasetPath(config));
  for (const index of config.sampleIndices) assert(dataset[index], `Unknown sample index: ${index}`);
  const modelEnvs = Object.values(config.models).flatMap(model => [model.baseURLEnv, model.apiKeyEnv, model.modelEnv]);
  if (config.memory.jevEnable) modelEnvs.push(config.memory.jevConnection.apiKeyEnv!);
  const missing = [...new Set(modelEnvs)].filter(name => !process.env[name]?.trim());
  console.log(JSON.stringify({ node: process.version, dataset: datasetPath(config), datasetSamples: dataset.length,
    selectedSamples: config.sampleIndices.length,
    selectedQuestions: config.sampleIndices.reduce((sum, index) => {
      const count = dataset[index].qa.filter(qa => config.categories.includes(qa.category)).length;
      return sum + (config.questionsPerSample === null ? count : Math.min(count, config.questionsPerSample));
    }, 0),
    datasetTurns: dataset.reduce((sum, sample) => sum + historyTurns(sample).length, 0),
    recallMode: config.memory.recallMode, jevEnabled: config.memory.jevEnable, missingEnvironment: missing,
    remoteCallsPerformed: 0 }, null, 2));
  assert.equal(missing.length, 0, `Set required environment variables: ${missing.join(", ")}`);
  for (const model of Object.values(config.models)) resolveModel(model);
}

function _spawnWorker(run: string, index: number): Promise<void> {
  const directory = join(run, `sample-${index}`);
  mkdirSync(directory);
  return new Promise((resolveWorker, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "worker", run, String(index)], {
      cwd: ROOT, stdio: "inherit",
      env: { ...process.env, HOME: join(directory, "home"), USERPROFILE: join(directory, "home"), MEMORY_DB_PATH: join(directory, "memory.db") },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveWorker();
      else reject(new Error(`Sample ${index} failed: exit=${code}, signal=${signal}`));
    });
  });
}

async function _run(configPath: string, runId: string): Promise<void> {
  assert(/^[A-Za-z0-9_-]+$/.test(runId), "run-id must contain letters, digits, underscores or hyphens");
  const config = readConfig(configPath);
  config.dataset = datasetPath(config);
  const dataset = readDataset(config.dataset);
  for (const index of config.sampleIndices) assert(dataset[index], `Unknown sample index: ${index}`);
  const models = {
    planner: modelIdentity(resolveModel(config.models.planner)), answer: modelIdentity(resolveModel(config.models.answer)),
    judge: modelIdentity(resolveModel(config.models.judge)),
  };
  if (config.memory.jevEnable) requiredEnv(config.memory.jevConnection.apiKeyEnv!);
  _safeDirectory(RUNS);
  const run = join(RUNS, runId);
  mkdirSync(run); // Existing runs throw: never overwrite or resume partial scores.
  const packageVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const manifest = {
    status: "running", startedAt: new Date().toISOString(), source: LOCOMO_SOURCE, packageVersion,
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(),
    gitStatus: execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }),
    node: process.version, models, config, prompts: PROMPTS, promptSha256: sha256(JSON.stringify(PROMPTS)),
    sourceSha256: { ..._sourceHashes(join(ROOT, "src")), ..._sourceHashes(join(ROOT, "prompts")),
      ...Object.fromEntries(["cli.ts", "config.ts", "dataset.ts", "metrics.ts", "models.ts", "pipeline.ts"].map(name =>
        [`evaluation/${name}`, sha256(readFileSync(join(ROOT, "evaluation", name)))])) },
    dependencyLockSha256: sha256(readFileSync(join(ROOT, "package-lock.json"))),
    evaluator: "pi-session-memory-project-judge-v1", temperature: 0,
    scope: "LoCoMo text + image captions; normal recall with one-pass answering; no fetch windows, Discussion or saved OKF reuse",
    selection: "First N eligible questions per selected sample; null means all eligible questions",
    evidencePolicy: "Exact dialogue IDs; empty or invalid annotations excluded and reported",
    tokenUsageScope: "Planner, answer and judge only; Jev token usage excluded",
  };
  writeFileSync(join(run, "config.json"), JSON.stringify(config, null, 2), { flag: "wx" });
  writeFileSync(join(run, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
  try {
    for (const index of config.sampleIndices) await _spawnWorker(run, index);
    const results: QuestionResult[] = config.sampleIndices.flatMap(index => {
      const lines = readFileSync(join(run, `sample-${index}`, "results.jsonl"), "utf8").trim().split("\n");
      return lines.map(line => JSON.parse(line) as QuestionResult);
    });
    const summary = summarize(results);
    writeFileSync(join(run, "summary.json"), JSON.stringify(summary, null, 2), { flag: "wx" });
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ ...manifest, status: "completed", completedAt: new Date().toISOString() }, null, 2));
    console.log(JSON.stringify({ run, ...summary }, null, 2));
  } catch (error) {
    writeFileSync(join(run, "manifest.json"), JSON.stringify({ ...manifest, status: "failed", failedAt: new Date().toISOString(), error: String(error) }, null, 2));
    throw error;
  }
}

async function _worker(runArgument: string, indexArgument: string): Promise<void> {
  const run = resolve(runArgument);
  assert.equal(dirname(run), RUNS, "Worker must use evaluation/runs");
  assert.equal(realpathSync(run), run, "Worker path must use a real directory");
  const index = Number(indexArgument);
  assert(Number.isSafeInteger(index) && index >= 0 && String(index) === indexArgument, "Invalid worker index");
  const config = readConfig(join(run, "config.json"));
  assert(config.sampleIndices.includes(index), "Worker sample is outside configured selection");
  const sample = readDataset(datasetPath(config))[index];
  assert(sample, "Missing sample");
  const directory = join(run, `sample-${index}`);
  assert.equal(realpathSync(directory), directory);
  const { evaluateSample } = await import("./pipeline.ts");
  await evaluateSample(sample, config, directory);
}

async function _main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true,
    options: { config: { type: "string" }, "run-id": { type: "string" } } });
  const [command, ...args] = positionals;
  switch (command) {
    case "download": assert(args.length === 0 && Object.keys(values).length === 0); await _download(); break;
    case "doctor": assert(args.length === 0 && values.config && !values["run-id"]); _doctor(resolve(values.config)); break;
    case "run": assert(args.length === 0 && values.config && values["run-id"]); await _run(resolve(values.config), values["run-id"]); break;
    case "worker": assert(args.length === 2 && Object.keys(values).length === 0); await _worker(args[0], args[1]); break;
    default: throw new Error("Usage: npm run eval -- download | doctor --config <file> | run --config <file> --run-id <unique-name>");
  }
}

await _main();
