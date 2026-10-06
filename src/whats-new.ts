import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "pi-session-memory", "whats-new.json");

const RELEASE_NOTES: Record<string, string> = {
  "0.7.1": `What's New in pi-session-memory v0.7.1

- Codex history import now supports optional and repeated message IDs and keeps parent and child threads separate.
- Native-session migration shares the same deterministic message identity rules without deduplicating repeated text.
- Existing Codex index entries are reparsed once after the parser upgrade, with transactional replacement and conflict rollback.
- The npm package version is now 0.7.1.`,

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
