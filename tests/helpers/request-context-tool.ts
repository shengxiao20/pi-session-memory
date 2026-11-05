import assert from "node:assert/strict";

/** Drive both extension boundaries: lightweight persisted result, then request-local context restoration. */
export function requestContextTool<T extends { execute: (...args: any[]) => Promise<any> }>(tool: T, context: () => (event: any) => any): T {
  return {
    ...tool,
    async execute(...args: any[]) {
      const persisted = await tool.execute(...args);
      if (persisted.details?.memory_context !== "transient") return persisted;
      assert.deepEqual(Object.keys(persisted.details).sort(), ["context_id", "memory_context", "tool_call_id", "tool_name"]);
      assert.match(persisted.content[0].text, /intermediate content is not stored in JSONL/);
      const message = { role: "toolResult", toolName: persisted.details.tool_name, toolCallId: persisted.details.tool_call_id, isError: false, timestamp: Date.now(), ...persisted };
      const restored = await context()({ messages: [message] });
      assert.notEqual(restored.messages[0].details.memory_context, "transient");
      assert.equal(persisted.details.memory_context, "transient", "request injection must not mutate the persisted result");
      const { role: _role, toolName: _toolName, toolCallId: _callId, isError: _error, timestamp: _time, ...result } = restored.messages[0];
      return result;
    },
  };
}
