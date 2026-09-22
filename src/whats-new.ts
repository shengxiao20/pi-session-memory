import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_PATH = join(homedir(), ".pi", "agent", "pi-session-memory", "whats-new.json");

const RELEASE_NOTES: Record<string, string> = {
  "0.6.1": `What's New in pi-session-memory v0.6.1

- Recall results now include a copyable Fetch session ID with its exact source prefix, such as pi:<id>.
- fetch_session now rejects IDs without pi:/claude:/codex: and explains how to copy the correct ID.`, 
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
