import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "pi-session-memory", "whats-new.json");

const RELEASE_NOTES: Record<string, string> = {
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
