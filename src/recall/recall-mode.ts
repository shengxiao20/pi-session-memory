import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RecallMode } from "../settings/config.ts";

export type SelectedRecallMode = Exclude<RecallMode, "choice">;

const MODE_OPTIONS: Record<SelectedRecallMode, string> = {
  normal: "normal — Read matching transcripts",
  discussion: "discussion — Consult confirmed historical sessions",
};

/** Choose delivery after retrieval. Never persist a choice or open a consultant. */
export async function selectRecallMode(
  mode: RecallMode,
  counts: { global: number; project: number },
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<SelectedRecallMode | undefined> {
  signal?.throwIfAborted();
  if (mode !== "choice") return mode;
  if (!ctx.hasUI) {
    throw new Error(
      "recallMode choice requires Pi TUI mode. " +
      "Set recallMode to normal or discussion for non-interactive use.",
    );
  }
  const title = [
    `Recall complete: ${counts.global + counts.project} unique turns`,
    `Global: ${counts.global} · Additional project turns: ${counts.project}`,
    "Choose how to use these results.",
    "normal: read source transcripts; no historical agents open.",
    "discussion: confirm eligible sessions, then consult them privately.",
    "This call only. ↑/↓ selects · Enter confirms · Esc cancels.",
  ].join("\n");
  const selection = await ctx.ui.select(title, Object.values(MODE_OPTIONS), { signal });
  signal?.throwIfAborted();
  if (selection === undefined) return undefined;
  const selected = (Object.keys(MODE_OPTIONS) as SelectedRecallMode[])
    .find(key => MODE_OPTIONS[key] === selection);
  if (selected === undefined) throw new Error("Unknown recall mode selection");
  return selected;
}
