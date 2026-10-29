import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "pi-session-memory", "whats-new.json");

const RELEASE_NOTES: Record<string, string> = {
  "0.7.23": `What's New in pi-session-memory v0.7.23

- Adds a two-line configuration snapshot to all six agent tool results and progress updates; compact recall keeps both lines visible.
- Reports Jev/model, Obsidian, manageOllama, recall limit, and set/unset states for MEMORY_DB_PATH, the configured API key environment variable and OLLAMA_HOST. Managed Ollama overrides its child process's OLLAMA_HOST.
- Never displays key values, database/vault paths or endpoint URLs. Configured switches do not imply runtime readiness; original evidence, structured details and Obsidian exports remain unchanged.
- Adds isolated decorator and E2E regressions for two-line output, progress, compact rendering, redaction and exports. Run /reload to load the updated local extension.`,
  "0.7.22": `What's New in pi-session-memory v0.7.22

- Handles asynchronous Ollama startup errors without crashing Pi; failures remain visible through existing runtime diagnostics.
- Assigns Pi replies through parentId, including alternate branches and intermediate non-message entries. Live writes and imports share complete-history user positions.
- Refreshes appended replies and tool names on repeated live writes instead of ignoring them. Preserves unanswered user turns and tool-only responses during import.
- Automatically repairs existing Pi, Claude Code and Codex indexes at the next session start through updated parser versions; source transcripts are not modified. Use fresh recall ranges after the upgrade.
- Validates every serialized single-segment Jev request against the existing budget before sending batches, including segments that start a new batch. Oversized requests raise an explicit error; no new fallback is added.
- Adds isolated regression tests for all five fixes. Run /reload to load the updated local extension.`,
  "0.7.21": `What's New in pi-session-memory v0.7.21

- Fixes recall text visibility by applying Pi's toolOutput foreground color to every line of compact results, expanded originals, progress and errors.
- Keeps tool-panel backgrounds and global theme settings unchanged; text follows the active Pi theme rather than terminal default colors.
- Includes the linked Chinese README in the npm package.
- Changes display only: retrieval, Jev filtering, deduplication, structured results and exports are unchanged. Run /reload to load the updated local extension.`,
  "0.7.20": `What's New in pi-session-memory v0.7.20

- Uses one System One client for Ollama, official Jev, and Qwen Decision API; no OpenAI Decisions adapter is added.
- Adds jevConnection with baseURL, apiKeyEnv, contextWindow and explicit manageOllama; model accepts any non-empty decision model name.
- Separates local Ollama startup, model pull and num_ctx inspection from API requests. Omitted connection configuration retains the original managed local behavior.
- Unmanaged connections require explicit model, API key environment variable and input budget; missing credentials raise errors, without backend detection or automatic switching.
- Keeps retrieval and relevance filtering unchanged. Remote filtering sends candidate transcript fragments and the complete question to the configured endpoint; reload after changing connection settings.`,
  "0.7.19": `What's New in pi-session-memory v0.7.19

- One recall_memory call automatically runs global recall first, then entity-discovered project recall with the same entities and question.
- Removes final project turns whose turn_id was already returned globally; no pre-query exclusion or refill is performed.
- Keeps ranking, recallLimit, directory matching, and optional Jev filtering unchanged. Jev statistics describe filtering before output deduplication.
- Displays Global recall and Project recall separately in tool progress and compact results; expanded results and Obsidian export contain the complete deduplicated output.
- Removes the separate recall_project_memory agent tool; manual global/project menu searches and review_jev_filtered keep their existing behavior.`,
  "0.7.18": `What's New in pi-session-memory v0.7.18

- Continues the bilingual Chinese and English README presentation.`,

  "0.7.17": `What's New in pi-session-memory v0.7.17

- Adds bilingual Chinese and English npm metadata and README documentation.`,

  "0.7.16": `What's New in pi-session-memory v0.7.16

- Adds the \`pi-extension\` npm keyword so the Pi package gallery's extension filter indexes this package correctly.`,

  "0.7.15": `What's New in pi-session-memory v0.7.15

- recall_project_memory no longer accepts project; it uses the same entities as global recall to match stored session CWD directory names.
- Any entity matching a stored project/session directory discovers those sessions, then the same entities search only their turns.
- Every prior-history question uses both global turn recall and entity-driven project-session recall without current runtime context.`,

  "0.7.14": `What's New in pi-session-memory v0.7.14

- recall_memory always searches every indexed transcript turn globally, without current Pi session, project, or CWD context.
- recall_project_memory runs only for a project-name keyword explicitly supplied by the user: it matches stored session CWD directory names first, then searches turns in matched sessions.
- Project lookup never derives a value from current runtime context.`,

  "0.7.13": `What's New in pi-session-memory v0.7.13

- recall_memory searches all transcript content globally, while recall_project_memory searches sessions belonging to the named project; these responsibilities are complementary.
- Prior-work questions involving the current project or any named project, repository, application, agent, service, or codebase must call both tools with identical entities and question.
- Project resolution uses only the explicit project argument and stored session CWD directory names, never the current CWD as a fallback.`,

  "0.7.11": `What's New in pi-session-memory v0.7.11

- recall_project_memory no longer accepts source or time filters and always searches every turn in all sessions resolved from project.
- Its public parameters are now limited to project, literal topic entities, and the complete question.`,

  "0.7.10": `What's New in pi-session-memory v0.7.10

- recall_memory now always searches every indexed SQLite turn and exposes no CWD, project, source, session, or time scope.
- Its public parameters are limited to literal topic entities and the complete question, preventing accidental narrowing of global recall.`,

  "0.7.9": `What's New in pi-session-memory v0.7.9

- When jevEnable is false, global and project recall now show only recall results without a redundant disabled Jev status section.
- Jev diagnostics remain visible when filtering is enabled, unavailable, or fails.`,

  "0.7.8": `What's New in pi-session-memory v0.7.8

- recall_memory is now guaranteed to search globally across every indexed project and no longer exposes a CWD parameter.
- Project-specific retrieval remains exclusively in recall_project_memory, which should be called alongside global recall when project context is relevant.
- Global review_jev_filtered audits can no longer be accidentally restricted by the current CWD.`,

  "0.7.7": `What's New in pi-session-memory v0.7.7

- Obsidian configuration is fully optional: omit obsidianExportEnabled and obsidianVaultPath to keep export disabled by default.
- Configure obsidianVaultPath only when explicitly enabling export with obsidianExportEnabled: true.`,

  "0.7.6": `What's New in pi-session-memory v0.7.6

- When obsidianExportEnabled is true, every completed history search automatically writes its complete result to one new Markdown note in obsidianVaultPath.
- No result selection is required, and Obsidian export is not registered as an agent tool or added to agent context.`,

  "0.7.5": `What's New in pi-session-memory v0.7.5

- Configuration-controlled Obsidian export: set obsidianExportEnabled and obsidianVaultPath, then explicitly select displayed search results from the menu.
- Obsidian export is not registered as an agent tool and is not added to agent context.`,

  "0.7.4": `What's New in pi-session-memory v0.7.4

- Explicitly export selected recalled turns to new Markdown notes in an existing Obsidian vault from the search menu.
- Exports require exact source turn IDs, never run automatically, and refuse to overwrite an existing note.`,

  "0.7.3": `What's New in pi-session-memory v0.7.3

- Startup history synchronization remains enabled, but the automatic sync summary is no longer displayed when a Pi session starts.
- Synchronization errors and Jev availability status notifications remain visible.`,

  "0.7.2": `What's New in pi-session-memory v0.7.2

- Codex history import now supports optional and repeated message IDs and keeps parent and child threads separate.
- Native-session migration shares the same deterministic message identity rules without deduplicating repeated text.
- Existing Codex index entries are reparsed once after the parser upgrade, with transactional replacement and conflict rollback.
- The npm package version is now 0.7.2.`,

  "0.7.0": `What's New in pi-session-memory v0.7.0

- One command only: use the /pi-session-memory folded menu for help, release notes, storage status, global/project recall, history import, and session migration. Former standalone slash commands are removed.
- Optional Jev filtering reviews already-ranked literal results locally and filters keyword-only false positives; review or setup failures keep literal recall active.
- Expanded agent tools include project-scoped recall, unified Claude Code/Codex migration, and review_jev_filtered for auditing filtered evidence.
- The global JSON configuration path and supported fields are documented in the Help menu and README.
- The npm package version is now 0.7.0.`,

  "0.6.2": `What's New in pi-session-memory v0.6.2

- Named-project recall now matches normalized project words against session CWD directory names alongside direct recall whenever project context is relevant.
- Use the same Chinese and English topic entities in both searches; project names remain metadata, not transcript search terms.
- Project topic search covers every matching session before recallLimit caps ranked turns; with no topic match, recallLimit caps recent session candidates.`,
};

interface WhatsNewState { shownVersion: string; }

/** Return the maintained release notes for a package version, or an empty string when none are published. */
export function getWhatsNew(version: string): string {
  return RELEASE_NOTES[version] ?? "";
}

/** Return unshown release notes once and persist the displayed package version globally. */
export function showWhatsNewIfUpdated(version: string): string | undefined {
  const state = _readState();
  if (state?.shownVersion === version) return undefined;
  _writeState({ shownVersion: version });
  return getWhatsNew(version);
}

function _readState(): WhatsNewState | undefined {
  if (!existsSync(STATE_PATH)) return undefined;
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as WhatsNewState;
}

function _writeState(state: WhatsNewState): void {
  mkdirSync(join(homedir(), ".pi", "agent", "pi-session-memory"), { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state)}\n`, "utf8");
}
