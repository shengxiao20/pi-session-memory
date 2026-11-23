import { Type } from "typebox";
import { PARAMETER_HELP } from "../../prompts/parameters.ts";

/** Required main-agent conclusion fields shared by every OKF writing tool. */
export const meetingConclusionSchema = Type.Object({
  title: Type.String({ minLength: 1, description: PARAMETER_HELP.meeting.title }),
  topic_path: Type.String({ minLength: 1, description: PARAMETER_HELP.meeting.topicPath }),
  topic_summaries: Type.Array(Type.Object({ title: Type.String({ minLength: 1 }), description: Type.String({ minLength: 1 }) }), { minItems: 1, description: PARAMETER_HELP.meeting.topicSummaries }),
  tags: Type.Array(Type.String({ minLength: 1 }), { description: PARAMETER_HELP.meeting.tags }),
  description: Type.String({ minLength: 1 }), findings: Type.String({ minLength: 1 }), decisions: Type.String({ minLength: 1 }),
  unverified_inferences: Type.String({ minLength: 1 }), disagreements: Type.String({ minLength: 1 }),
  open_questions: Type.String({ minLength: 1 }), actions: Type.String({ minLength: 1 }),
});
