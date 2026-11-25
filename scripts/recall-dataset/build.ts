import assert from "node:assert/strict";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCandidates, selectCandidates, setProjectSplits } from "./candidates.ts";
import { exportCorpus, validateCorpus } from "./source.ts";
import { validateDataset } from "./validate.ts";
import { DEFAULT_QUOTAS, type Category } from "./types.ts";

const DEFAULT_DB = resolve(homedir(), ".pi/agent/memory.db");
const DEFAULT_OUTPUT = resolve(homedir(), ".pi/agent/pi-session-memory/datasets/pi-recallbench-v1");

function argumentsFrom(argv: string[]): { database: string; output: string; cutoff: number } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]!;
    assert(["--database", "--output", "--cutoff"].includes(key), `Unknown option: ${key}`);
    const value = argv[++index];
    assert(value && !value.startsWith("--"), `Missing value for ${key}`);
    args.set(key, value);
  }
  const cutoffText = args.get("--cutoff");
  const cutoff = cutoffText === undefined ? Date.now() : Number(cutoffText);
  assert(Number.isSafeInteger(cutoff) && cutoff > 0, "--cutoff must be Unix milliseconds");
  return { database: resolve(args.get("--database") ?? DEFAULT_DB), output: resolve(args.get("--output") ?? DEFAULT_OUTPUT), cutoff };
}

function jsonl(values: unknown[]): string { return `${values.map(value => JSON.stringify(value)).join("\n")}\n`; }

export function buildDataset(options = argumentsFrom(process.argv.slice(2))): { output: string; summary: Record<string, unknown> } {
  assert(!existsSync(options.output), `Output already exists; choose a new --output directory: ${options.output}`);
  const { corpus, cutoff_timestamp, exclusions } = exportCorpus(options.database, options.cutoff);
  validateCorpus(corpus);
  const projectSessions = new Map<string, Set<string>>();
  for (const turn of corpus) {
    const sessions = projectSessions.get(turn.project_id) ?? new Set<string>();
    sessions.add(turn.session_id); projectSessions.set(turn.project_id, sessions);
  }
  setProjectSplits([...projectSessions].map(([project_id, sessions]) => ({ project_id, sessions: sessions.size })));
  const pool = buildCandidates(corpus);
  const selected = selectCandidates(pool.candidates, DEFAULT_QUOTAS);
  const summary = validateDataset(corpus, selected);
  const shortages = Object.fromEntries((Object.keys(DEFAULT_QUOTAS) as Category[])
    .filter(category => pool.available[category] < DEFAULT_QUOTAS[category])
    .map(category => [category, { requested: DEFAULT_QUOTAS[category], available: pool.available[category] }]));
  const output = options.output;
  const staging = `${output}.building-${process.pid}`;
  assert(!existsSync(staging), `Staging directory already exists: ${staging}`);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  mkdirSync(staging, { mode: 0o700 });
  try {
    const manifest = {
      dataset: "Pi RecallBench candidate set", schema_version: 1, build_version: "1.0.0",
      generated_at: new Date().toISOString(), source_cutoff_unix_ms: cutoff_timestamp,
      source: "Local read-only pi-session-memory SQLite index; original Pi session files were not changed",
      privacy: { local_private_data: true, raw_project_paths_exported: false, source_text_redacted: true,
        automatic_secret_screening: true, human_privacy_review_required_before_sharing: true },
      candidate_policy: { gold_labels: "unset until a human reviewer confirms each answer and evidence",
        default_quotas: DEFAULT_QUOTAS, available_candidate_pool: pool.available, quota_shortages: shortages,
        split_rule: "Keep each project in one split; projects ordered by descending session count then project ID, repeating 14 train / 3 dev / 3 test slots" },
      exclusions, validation: summary,
    };
    const files: Record<string, string> = {
      "corpus.jsonl": jsonl(corpus),
      "candidates.jsonl": jsonl(selected),
      "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
      "README.md": `# Pi RecallBench candidate set\n\nThis private dataset was built from the local Pi transcript index. It contains sanitized source turns and evidence-linked candidate questions.\n\n## Review before evaluation\n\n- Every candidate has \`review_status: pending\`, \`answerable: null\`, and \`gold_answer: null\`. A candidate answer is an extractive suggestion, not a gold label.\n- Check each question, source range, quote, project scope, cutoff time, and answerability. Replace a rejected item or mark it excluded in a reviewed copy.\n- For \`insufficient_evidence\`, verify the full project history up to the cutoff. Exact-string absence alone does not prove semantic absence.\n- Preserve project-group splits. Do not move turns or projects between train, dev, and test after viewing test answers.\n- The corpus includes private conversation text. Do not publish it until a human has checked names, confidential code, credentials, customer details, and employer information.\n- Automated secret screening is incomplete.\n\n## Files\n\n- \`corpus.jsonl\`: locally indexed Pi turns after screening and basic redaction.\n- \`candidates.jsonl\`: 100 candidate questions by default, with source references and stable project-level splits.\n- \`manifest.json\`: generation cutoff, exclusions, split rule, candidate-pool counts, and validation results.\n\nAll files are written with owner-only permissions. Rebuild to a new output directory; existing datasets are never overwritten.\n`,
    };
    for (const [name, content] of Object.entries(files)) {
      const path = resolve(staging, name);
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    }
    chmodSync(staging, 0o700);
    renameSync(staging, output);
    return { output, summary: { ...summary, exclusions, candidate_pool: pool.available, quota_shortages: shortages } };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = buildDataset();
  console.log(JSON.stringify(result, null, 2));
}
