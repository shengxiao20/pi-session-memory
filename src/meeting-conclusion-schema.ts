import { Type } from "typebox";

/** Required main-agent conclusion fields shared by both OKF finish tools. */
export const meetingConclusionSchema = Type.Object({
  description: Type.String({ minLength: 1 }), findings: Type.String({ minLength: 1 }), decisions: Type.String({ minLength: 1 }),
  unverified_inferences: Type.String({ minLength: 1 }), disagreements: Type.String({ minLength: 1 }),
  open_questions: Type.String({ minLength: 1 }), actions: Type.String({ minLength: 1 }),
});
