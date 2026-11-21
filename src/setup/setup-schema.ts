import { Type } from "typebox";
import { PARAMETER_HELP } from "../../prompts/parameters.ts";
import { RECALL_MODES, DEFAULT_RECALL_MODE } from "../settings/config.ts";

/** Only supported JSON settings can be supplied by setup; unknown existing top-level keys are retained on disk. */
export const setupConfigurationSchema = Type.Object({
  recallLimit: Type.Integer({ minimum: 1 }),
  recallMode: Type.Optional(Type.Union(RECALL_MODES.map(mode => Type.Literal(mode)), { default: DEFAULT_RECALL_MODE })),
  consultation: Type.Optional(Type.Object({ timeoutMs: Type.Integer({ minimum: 1 }), turnThreshold: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 5, description: PARAMETER_HELP.setup.turnThreshold })) }, { additionalProperties: false })),
  jevEnable: Type.Optional(Type.Boolean()), model: Type.Optional(Type.String({ minLength: 1 })),
  jevConnection: Type.Optional(Type.Object({ baseURL: Type.String({ minLength: 1 }), manageOllama: Type.Boolean(), apiKeyEnv: Type.Optional(Type.String({ minLength: 1 })), contextWindow: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false })),
  knowledgePath: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
