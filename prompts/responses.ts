// Agent-facing setup responses.
// Call sites serialize configuration before formatting.
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
    "\nTools reread settings on invocation. Restart Pi for startup " +
    "synchronization and service readiness checks. No history " +
    "operations or service checks ran during this save."
  );
}
