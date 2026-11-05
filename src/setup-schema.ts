import { Type } from "typebox";

/** Only supported JSON settings can be supplied by setup; unknown existing top-level keys are retained on disk. */
export const setupConfigurationSchema = Type.Object({
  recallLimit: Type.Integer({ minimum: 1 }),
  enableDiscussion: Type.Optional(Type.Boolean()),
  consultation: Type.Optional(Type.Object({ timeoutMs: Type.Integer({ minimum: 1 }), knowledgePath: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false })),
  jevEnable: Type.Optional(Type.Boolean()), model: Type.Optional(Type.String({ minLength: 1 })),
  jevConnection: Type.Optional(Type.Object({ baseURL: Type.String({ minLength: 1 }), manageOllama: Type.Boolean(), apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })), contextWindow: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false })),
  obsidianExportEnabled: Type.Optional(Type.Boolean()), obsidianVaultPath: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
