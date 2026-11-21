import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `pi-session-history-${process.pid}.db`);
const historyHome = join(tmpdir(), `pi-session-history-home-${process.pid}`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.HOME = historyHome;
process.env.USERPROFILE = historyHome; // os.homedir() uses USERPROFILE on Windows.

const { getDb, getHistoryStats, getSession, insertTurn, upsertSession } = await import("../src/history/db.ts");
const { fetchTurnContext } = await import("../src/history/fetch-turn-context.ts");
const { formatRecallResults, recallTurns } = await import("../src/recall/retriever.ts");
const { formatProjectRecallResults, recallProjectMemory } = await import("../src/recall/project-retriever.ts");
const { backfillAll, syncChangedHistory } = await import("../src/history/backfill.ts");
const { getSessionMemoryConfig, JEV_MODELS, DEFAULT_JEV_CONNECTION } = await import("../src/settings/config.ts");

function cleanup(): void { for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true }); rmSync(historyHome, { recursive: true, force: true }); }
cleanup();

const extensionSource = readFileSync(join(process.cwd(), "extensions", "index.ts"), "utf8");
assert.match(extensionSource, /"pi-session-memory"/);
assert.doesNotMatch(extensionSource, /registerCommand\("(?!(?:pi-session-memory)")/);
const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
const changelog = readFileSync(join(process.cwd(), "CHANGELOG.md"), "utf8");
const packageManifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
const lockManifest = JSON.parse(readFileSync(join(process.cwd(), "package-lock.json"), "utf8"));
assert.equal(packageManifest.version, "2.0.10");
assert.equal(lockManifest.version, packageManifest.version);
assert.equal(lockManifest.packages[""].version, packageManifest.version);
assert.ok(readme.includes(`Current version: ${packageManifest.version}`));
assert.match(packageManifest.description, /SQLite-backed search/);
assert.match(packageManifest.description, /instead of relying on lossy summaries/);
assert.match(readme, /Retrieve source evidence instead of relying on lossy summaries/);
assert.match(readme, /does not replace compaction/);
assert.match(packageManifest.description, /multi-agent discussion/);
assert.match(packageManifest.description, /reusable, evidence-based knowledge/);
for (const keyword of ["pi-package", "pi-extension", "sqlite", "multi-agent", "conversation-history"]) {
  assert.ok(packageManifest.keywords.includes(keyword), `npm keywords include ${keyword}`);
}
assert.equal(new Set(packageManifest.keywords).size, packageManifest.keywords.length, "npm keywords are unique");
assert.match(readme, /not typo-tolerant fuzzy search or vector similarity/);
assert.match(readme, /Version 1\.0 added nine tools/);
assert.match(readme, /The npm `latest` release before 1\.0 is \*\*0\.7\.23\*\*/);
assert.match(readme, /Context and index isolation/);
assert.match(extensionSource, /registerSetupTools/);
assert.ok(packageManifest.files.includes("prompts/"), "setup guide and prompt modules must be included in the npm package");
assert.deepEqual(packageManifest.pi.prompts, [], "internal prompt resources must not add slash commands");
assert.match(extensionSource, /registerMemoryCleanupTools/);
assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/);
assert.match(readme, /Extension Updates/);
assert.doesNotMatch(readme, /README_zh|## What's new in/);
assert.ok(packageManifest.files.includes("CHANGELOG.md"), "npm releases must include native package release notes");
assert.ok(!packageManifest.files.includes("README_zh.md"));
assert.ok(!existsSync(join(process.cwd(), "README_zh.md")), "Chinese documentation is removed");
assert.ok(!existsSync(join(process.cwd(), "src", "whats-new.ts")), "custom release-note state management is removed");
assert.doesNotMatch(`${readme}\n${changelog}\n${packageManifest.description}`, /[\u4e00-\u9fff]/, "documentation and npm descriptions must be English only");
assert.doesNotMatch(extensionSource, /whatsNew|getWhatsNew|showWhatsNewIfUpdated|whats-new|packageJson/);
const releaseEntries = changelog.split(/^## \[(\d+\.\d+\.\d+)\]\s*$/m);
const releaseVersions = releaseEntries.filter((_entry, index) => index % 2 === 1);
assert.deepEqual(releaseVersions, [packageManifest.version, "2.0.9", "2.0.8", "2.0.7", "2.0.6", "2.0.5", "2.0.4", "2.0.3", "2.0.2", "2.0.1", "2.0.0", "1.1.2", "1.1.1", "1.1.0", "1.0.1", "1.0.0"], "native changelog contains current release notes, the layout change, and the 1.0 baseline");
for (let index = 1; index < releaseEntries.length; index += 2) {
  assert.match(releaseEntries[index + 1]!, /^\s*(?:Version|[#-])/, `release ${releaseEntries[index]} must contain notes`);
}
const notesByVersion = new Map(releaseVersions.map((version, index) => [version, releaseEntries[index * 2 + 2]!]));
assert.match(notesByVersion.get("2.0.10")!, /One OKF knowledge root/);
assert.match(notesByVersion.get("2.0.10")!, /independent top-level `knowledgePath`/);
assert.match(notesByVersion.get("2.0.10")!, /no automatic path conversion, document migration, or duplicate output/);
assert.match(notesByVersion.get("2.0.9")!, /Recall delivery modes/);
assert.match(notesByVersion.get("2.0.9")!, /recallMode/);
assert.match(readme, /`choice` \(default\)/);
assert.match(notesByVersion.get("2.0.5")!, /Centralized prompt resources/);
assert.match(notesByVersion.get("2.0.5")!, /pi.prompts: \[\]/);
assert.match(notesByVersion.get("2.0.8")!, /Recall input validation/);
assert.match(notesByVersion.get("2.0.8")!, /Removes the two-to-eight entity count bounds/);
assert.match(notesByVersion.get("2.0.8")!, /Allows punctuation-only entities/);
assert.match(readme, /Non-empty literal strings, with no fixed entity count/);
assert.match(readme, /An empty entity list still fails/);
assert.match(notesByVersion.get("2.0.7")!, /Agentic setup menu/);
assert.match(notesByVersion.get("2.0.7")!, /before `Edit configuration`/);
assert.match(notesByVersion.get("2.0.6")!, /Prompt lint and formatting/);
assert.match(notesByVersion.get("2.0.6")!, /npm run lint/);
assert.match(packageManifest.scripts.lint, /eslint prompts\/ --max-warnings=0/);
assert.match(packageManifest.scripts.lint, /prettier prompts\/ --check/);
assert.equal(packageManifest.scripts.format, "prettier prompts/ --write");
assert.equal(packageManifest.scripts.typecheck, "tsc --noEmit");
assert.match(packageManifest.scripts.test, /^npm run typecheck && npm run lint && /);
const compilerOptions = JSON.parse(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")).compilerOptions;
assert.equal(compilerOptions.strict, true);
assert.equal(compilerOptions.noUnusedLocals, true);
assert.equal(compilerOptions.noUnusedParameters, true);
assert.ok(!compilerOptions.skipLibCheck, "dependency declarations must remain part of the typecheck gate");
assert.match(notesByVersion.get("2.0.4")!, /Compact, immediate configuration editing/);
assert.match(notesByVersion.get("2.0.4")!, /Removes Save, Cancel/);
assert.match(notesByVersion.get("2.0.4")!, /Saves each valid field immediately/);
assert.match(notesByVersion.get("2.0.3")!, /Direct configuration editor/);
assert.match(notesByVersion.get("2.0.3")!, /13 supported fields/);
assert.match(notesByVersion.get("2.0.3")!, /consultation.turnThreshold/);
assert.match(notesByVersion.get("2.0.2")!, /Historical-session turn threshold/);
assert.match(notesByVersion.get("2.0.2")!, /PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD/);
assert.match(notesByVersion.get("2.0.2")!, /exclusive threshold with default `5`/);
assert.match(notesByVersion.get("2.0.2")!, /Removes the three-session candidate cap/);
const { TOOL_PROMPTS } = await import("../prompts/tools.ts");
assert.match(TOOL_PROMPTS.recall_memory.description, /consultation.turnThreshold \(default 5; overridden by PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD\)/);
assert.doesNotMatch(extensionSource, /up to three native Pi candidate sessions/);
assert.match(notesByVersion.get("2.0.1")!, /Focused meeting navigation/);
assert.match(notesByVersion.get("2.0.1")!, /Lists only `minutes.md`/);
assert.match(notesByVersion.get("2.0.1")!, /Retains all evidence files, structured sources, and Sources footnotes/);
assert.match(notesByVersion.get("2.0.1")!, /duplicate source IDs or targets/);
assert.match(notesByVersion.get("2.0.0")!, /Breaking: OKF concepts and topic navigation/);
assert.match(notesByVersion.get("2.0.0")!, /Does not migrate or automatically delete legacy knowledge/);
assert.match(notesByVersion.get("2.0.0")!, /Preserves source JSONL, SQLite history, configuration keys/);
assert.match(notesByVersion.get("1.1.2")!, /CodeGraph Map illustration/);
assert.match(notesByVersion.get("1.0.0")!, /English labels/);
assert.match(notesByVersion.get("1.0.0")!, /original language/);
assert.match(notesByVersion.get("1.0.0")!, /Expands the registered Agent tools from 6 to 15/);
assert.match(notesByVersion.get("1.0.0")!, /saved-knowledge-first review/);
assert.match(readme, /A missing file is reported as missing/);
assert.match(readme, /Main-agent tools and permissions remain unchanged/);
assert.doesNotMatch(`${readme}\n${extensionSource}`, /unavailable in consultation mode|reject calls while consultation is enabled|Use only when consultation is disabled/);
assert.match(readme, /All eligible candidates start selected/);
assert.match(readme, /scrollable checklist/);
assert.match(readme, /PI_SESSION_MEMORY_DISCUSSION_TURN_THRESHOLD/);
assert.match(readme, /at least 6 hits/);
assert.doesNotMatch(readme, /up to three|shortlist of up to three/i);
rmSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true, force: true });
mkdirSync(join(historyHome, ".pi", "agent", "pi-session-memory"), { recursive: true });
const configPath = join(historyHome, ".pi", "agent", "pi-session-memory", "config.json");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));
assert.deepEqual(getSessionMemoryConfig(), { recallMode: "choice", recallLimit: 2, jevEnable: false, model: "nimble", jevConnection: DEFAULT_JEV_CONNECTION, knowledgePath: undefined }, "omitted recallMode defaults to choice; other documented defaults stay unchanged");
for (const model of JEV_MODELS) {
  writeFileSync(configPath, JSON.stringify({ recallLimit: 2, jevEnable: true, model }));
  assert.deepEqual(getSessionMemoryConfig(), { recallMode: "choice", recallLimit: 2, jevEnable: true, model, jevConnection: DEFAULT_JEV_CONNECTION, knowledgePath: undefined });
}
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, model: "custom-decision-model" }));
assert.equal(getSessionMemoryConfig().model, "custom-decision-model");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, model: " " }));
assert.throws(() => getSessionMemoryConfig(), /model must be a non-empty string/);
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, obsidianExportEnabled: true }));
assert.throws(() => getSessionMemoryConfig(), /obsidianExportEnabled, obsidianVaultPath and consultation.knowledgePath are no longer supported/);
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, obsidianExportEnabled: true, obsidianVaultPath: "/vault" }));
assert.throws(() => getSessionMemoryConfig(), /are no longer supported/);
writeFileSync(configPath, JSON.stringify({ recallLimit: 2, knowledgePath: "/knowledge" }));
assert.equal(getSessionMemoryConfig().knowledgePath, "/knowledge");
assert.equal(getSessionMemoryConfig().consultation, undefined, "knowledgePath does not require consultation");
writeFileSync(configPath, JSON.stringify({ recallLimit: 2 }));

for (const toolName of ["recall_memory", "fetch_session", "get_memory_stats", "backfill_memory"]) assert.match(extensionSource, new RegExp(`name: "${toolName}"`));
assert.doesNotMatch(extensionSource, /name: "recall_project_memory"/);
assert.doesNotMatch(extensionSource, /name: "export_recall_to_obsidian"/);
assert.doesNotMatch(extensionSource, /name: "migrate_project_sessions"/);
assert.match(extensionSource, /edit: "Edit configuration"/);
assert.match(extensionSource, /setup: "Agentic setup"/);
assert.match(extensionSource, /setup: "Agentic setup",\s*edit: "Edit configuration"/);
assert.doesNotMatch(extensionSource, /setup: "Setup"/);
assert.match(extensionSource, /clean: "Clean indexed tool turns"/);
assert.match(extensionSource, /backfill: "Import history"/);
assert.doesNotMatch(extensionSource, /Search (?:project )?history —/);
assert.doesNotMatch(extensionSource, /"memory-project-search"/);
assert.match(TOOL_PROMPTS.recall_memory.description, /One call with literal topic entities/);
assert.doesNotMatch(TOOL_PROMPTS.recall_memory.description, /2-8/);
assert.match(TOOL_PROMPTS.recall_memory.description, /then uses those same entities to discover stored session CWD final-directory names/);
assert.match(TOOL_PROMPTS.recall_memory.description, /No current Pi session, project, CWD, source, session, or time context is used/);
assert.match(TOOL_PROMPTS.fetch_session.description, /This is read-only and never creates a memory/);

upsertSession({ session_id: "pi:project-a", source: "pi", cwd: "/workspace/project-a", started_at: 1, model_id: null, jsonl_path: "/tmp/project-a.jsonl" });
for (const [index, text] of ["deploy memory testing", "deploy memory release", "literal %_\\ marker"] .entries()) {
  assert.equal(insertTurn({ turn_id: `pi:project-a:user-${index + 1}`, session_id: "pi:project-a", turn_index: index, ts: index + 1, user_text: text, reply_text: "confirmed", tool_names: null, user_message_id: `user-${index + 1}` }), true);
}
assert.deepEqual(recallTurns({ entities: ["deploy"] }).map((turn) => turn.turn_id), ["pi:project-a:user-2", "pi:project-a:user-1"]);
assert.deepEqual(recallTurns({ entities: ["%_\\"] }).map((turn) => turn.turn_id), ["pi:project-a:user-3"]);
assert.deepEqual(recallTurns({ entities: ["deploy"], cwd: "/wrong" }), []);
assert.deepEqual(recallTurns({ entities: ["deploy"], sessionIds: ["pi:missing"] }), []);
const deployResults = recallTurns({ entities: ["deploy"] });
assert.equal(deployResults.length, 2);
assert.match(formatRecallResults(deployResults, { entities: ["deploy"] }), /\*\*Results:\*\* 2[\s\S]*Matching raw conversation history[\s\S]*\*\*Fetch turn ID:\*\* `pi:project-a:user-2`[\s\S]*fetch_session.turn_id/);
for (let index = 0; index < 6; index++) {
  assert.equal(insertTurn({ turn_id: `pi:project-a:extra-${index}`, session_id: "pi:project-a", turn_index: index + 3, ts: index + 4, user_text: "complete result set", reply_text: "", tool_names: null, user_message_id: `extra-${index}` }), true);
}
assert.equal(recallTurns({ entities: ["complete"] }).length, 2, "recall must use the single configured result limit");
upsertSession({ session_id: "pi:memory-project", source: "pi", cwd: "C:\\work\\pi-session-memory\\", started_at: 11, model_id: null, jsonl_path: "/tmp/pi-session-memory.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:memory-project:user-1", session_id: "pi:memory-project", turn_index: 0, ts: 11, user_text: "设计数据库 schema", reply_text: "SQLite tables", tool_names: null, user_message_id: "memory-user-1" }), true);
const bilingualTopicEntities = ["数据库", "database"];
assert.deepEqual(recallTurns({ entities: bilingualTopicEntities }).map((turn) => turn.turn_id), ["pi:memory-project:user-1"], "global content recall matches transcript entities independently");
const projectEntities = ["pi session memory", "数据库", "database"];
const projectRecall = recallProjectMemory({ entities: projectEntities });
assert.deepEqual(projectRecall.results.map((turn) => turn.turn_id), ["pi:memory-project:user-1"], "an entity discovers the stored CWD directory before the same entities search that session's transcript content");
assert.equal(recallTurns({ entities: ["pi-session-memory"] }).length, 0, "target project name may be absent from its own transcript");
const missingProjectEntities = ["pi session memory", "不存在主题", "nonexistent topic"];
const noTopicProjectRecall = recallProjectMemory({ entities: missingProjectEntities });
assert.deepEqual(noTopicProjectRecall.results, []);
assert.deepEqual(noTopicProjectRecall.sessions.map((session) => session.session_id), ["pi:memory-project"]);
assert.match(formatProjectRecallResults(noTopicProjectRecall, { entities: missingProjectEntities }), /Session-name match:[\s\S]*Project session candidates[\s\S]*pi:memory-project/);
assert.doesNotMatch(formatProjectRecallResults(noTopicProjectRecall, { entities: missingProjectEntities }), /Fetch turn ID|Fetch session ID|fetch_session\.session_id/);
assert.match(formatProjectRecallResults(projectRecall, { entities: projectEntities }), /Fetch turn ID[\s\S]*pi:memory-project:user-1[\s\S]*fetch_session\.turn_id/);
assert.deepEqual(recallProjectMemory({ entities: ["pi-session-memory-fork", ...bilingualTopicEntities] }).sessions, [], "an unmatched directory entity must not discover a session when no other entity matches its directory name");
assert.deepEqual(recallProjectMemory({ entities: ["pi session", ...bilingualTopicEntities] }).sessions.map((session) => session.session_id), ["pi:memory-project"], "space-separated entity tokens must match a hyphenated final CWD directory name");
for (let index = 0; index < 3; index++) {
  upsertSession({ session_id: `pi:project-candidate-${index}`, source: "pi", cwd: "/workspace/pi-session-memory", started_at: 20 + index, model_id: null, jsonl_path: `/tmp/project-candidate-${index}.jsonl` });
  assert.equal(insertTurn({ turn_id: `pi:project-candidate-${index}:user-1`, session_id: `pi:project-candidate-${index}`, turn_index: 0, ts: 20 + index, user_text: "unrelated candidate", reply_text: "", tool_names: null, user_message_id: `candidate-${index}` }), true);
}
const limitedProjectCandidates = recallProjectMemory({ entities: missingProjectEntities });
assert.deepEqual(limitedProjectCandidates.sessions.map((session) => session.session_id), ["pi:project-candidate-2", "pi:project-candidate-1"], "project candidates without topic matches must use recallLimit");
const olderProjectMatch = recallProjectMemory({ entities: projectEntities });
assert.deepEqual(olderProjectMatch.results.map((turn) => turn.turn_id), ["pi:memory-project:user-1"], "topic search must include project sessions older than the candidate display limit");
assert.deepEqual(olderProjectMatch.sessions.map((session) => session.session_id), ["pi:memory-project"], "successful recall must return metadata only for sessions represented in ranked results");
upsertSession({ session_id: "pi:native-app", source: "pi", cwd: "/workspace/pi-native-app", started_at: 12, model_id: null, jsonl_path: "/tmp/pi-native-app.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:native-app:user-1", session_id: "pi:native-app", turn_index: 0, ts: 12, user_text: "数据库 design", reply_text: "SQLite", tool_names: null, user_message_id: "native-app-user-1" }), true);
assert.deepEqual(recallProjectMemory({ entities: ["pi native app", ...bilingualTopicEntities] }).sessions.map((session) => session.session_id), ["pi:native-app"], "an entity token sequence may discover a matching final CWD directory name");
const fetched = fetchTurnContext("pi:project-a:user-2", 0, 0);
assert.deepEqual(fetched.stored.turns.map((turn) => turn.turn_id), ["pi:project-a:user-2"]);
upsertSession({ session_id: "pi:session-uuid", source: "pi", cwd: "/workspace/project-a", started_at: 10, model_id: null, jsonl_path: "/tmp/session.jsonl" });
assert.equal(insertTurn({ turn_id: "pi:session-uuid:user-1", session_id: "pi:session-uuid", turn_index: 0, ts: 10, user_text: "Pi source-prefix test", reply_text: "confirmed", tool_names: null, user_message_id: "user-1" }), true);
const piResults = recallTurns({ entities: ["source-prefix"] });
assert.match(formatRecallResults(piResults, { entities: ["source-prefix"] }), /\*\*Fetch turn ID:\*\* `pi:session-uuid:user-1`/);
assert.deepEqual(fetchTurnContext("pi:session-uuid:user-1", 0, 0).stored.turns.map((turn) => turn.turn_id), ["pi:session-uuid:user-1"]);
assert.throws(() => fetchTurnContext("session-uuid", 0, 0), /History turn not found/);
const initialStats = getHistoryStats();
assert.equal(initialStats.sessions, 7);
assert.equal(initialStats.turns, 15);
assert.equal(initialStats.oldestTs, 1);
assert.equal(initialStats.newestTs, 22);
assert.deepEqual(initialStats.sources.map((source) => ({ ...source })), [
  { source: "pi", sessions: 7, turns: 15 },
]);

mkdirSync(join(historyHome, ".pi", "agent", "sessions"), { recursive: true });
const fixture = join(historyHome, ".pi", "agent", "sessions", "fixture.jsonl");
writeFileSync(fixture, [
  JSON.stringify({ type: "session", version: 3, id: "imported", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/imported" }),
  JSON.stringify({ type: "message", id: "u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", timestamp: 1, content: [{ type: "text", text: "import me" }] } }),
  JSON.stringify({ type: "message", id: "a", parentId: "u", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", timestamp: 2, content: [{ type: "text", text: "imported reply" }] } }),
].join("\n"));
assert.equal(syncChangedHistory().turns, 1);
assert.equal(syncChangedHistory().skippedFiles, 1);
assert.equal(backfillAll().scannedFiles, 1);
assert.ok(getSession("pi:imported").turns.length === 1);
writeFileSync(fixture, [
  JSON.stringify({ type: "session", version: 3, id: "imported", timestamp: "2026-01-02T00:00:00.000Z", cwd: "/reindexed" }),
  JSON.stringify({ type: "model_change", id: "model", parentId: null, timestamp: "2026-01-02T00:00:00.000Z", modelId: "updated-model" }),
  JSON.stringify({ type: "message", id: "u-updated", parentId: null, timestamp: "2026-01-02T00:00:01.000Z", message: { role: "user", timestamp: 3, content: [{ type: "text", text: "replacement user" }] } }),
  JSON.stringify({ type: "message", id: "a-updated", parentId: "u-updated", timestamp: "2026-01-02T00:00:02.000Z", message: { role: "assistant", timestamp: 4, content: [{ type: "text", text: "replacement reply" }] } }),
].join("\n"));
assert.equal(backfillAll().turns, 1, "a force backfill must replace changed source data");
const replacedImported = getSession("pi:imported");
assert.equal(replacedImported.session.cwd, "/reindexed");
assert.equal(replacedImported.session.model_id, "updated-model");
assert.deepEqual(replacedImported.turns.map((turn) => [turn.user_message_id, turn.user_text, turn.reply_text]), [["u-updated", "replacement user", "replacement reply"]], "replacement must delete source turns that no longer exist");

getDb().close();
cleanup();
console.log("core.test.ts: passed");
