import { CONSULTATION_ACTIVE_GUIDANCE, CONSULTATION_CLOSED_GUIDANCE } from "../../prompts/guidance.ts";
export { MAIN_AGENT_NOTICE, CONSULTATION_CLOSED_NOTICE } from "../../prompts/guidance.ts";

export function consultationGuidance(consultationId: string | null): string {
  if (consultationId === null) return CONSULTATION_CLOSED_GUIDANCE;
  return CONSULTATION_ACTIVE_GUIDANCE;
}
