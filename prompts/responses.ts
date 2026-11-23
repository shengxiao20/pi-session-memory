// Agent-facing setup responses.
// Call sites serialize configuration before formatting.
import { POST_SETUP_IMPORT_NOTICE } from "./guidance.ts";
export function setupReadResponse(
  guide: string,
  configuration: string,
): string {
  return `${guide}\n\nCurrent configuration:\n${configuration}`;
}

export function setupSavedResponse(
  configPath: string,
  configuration: string,
): string {
  return (
    `Saved pi-session-memory configuration: ${configPath}\n` +
    `${configuration}` +
    "\nTools reread settings on invocation. Restart Pi for service " +
    "readiness checks, not history import. No history operations " +
    "or service checks ran during this save.\n" +
    POST_SETUP_IMPORT_NOTICE
  );
}
