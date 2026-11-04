import { LLM_FAST_MODEL, LLM_MODEL, LLM_PROVIDER, MODEL_CASCADE, isMockLlm } from "../config";
import { scoreConfidence } from "./confidence";
import type { GenerationFailure } from "./llmErrors";
import type { ParseResult } from "./parser";
import type { ResolvedEdits } from "./resolve";
import { validateFileOps } from "./validate";

/** Short requests against an existing app are usually small edits; longer ones go straight to the strongest model. */
const SMALL_CHANGE_MAX_CHARS = 300;
/** Below this, the fast model's result is redone by the strongest model. */
const MIN_CONFIDENCE_TO_KEEP = 80;

export type Tier = "fast" | "best";

/**
 * Model cascade: small changes try the fast model first and escalate once to the strongest model
 * if the result fails the same mechanical checks as the confidence score. New apps start on the best model.
 */
export function chooseTier(input: { hasFiles: boolean; prompt: string; enabled: boolean }): Tier {
  if (!input.enabled || !input.hasFiles || input.prompt.length > SMALL_CHANGE_MAX_CHARS) return "best";
  return "fast";
}

export const cascadeEnabled = () => MODEL_CASCADE.value() === "on" && !isMockLlm() && LLM_PROVIDER.value() !== "gemini";
export const modelFor = (tier: Tier) => (tier === "fast" ? LLM_FAST_MODEL.value() : LLM_MODEL.value());

/** Why a fast-model result shouldn't be kept, or null to keep it. Provider errors and refusals aren't fixed by escalating. */
export function escalationReason(input: {
  existing: Map<string, string>;
  parsed: ParseResult;
  resolved: ResolvedEdits;
  failure: GenerationFailure | null;
}): string | null {
  if (input.failure) return null;
  if (input.parsed.incomplete) return "a file was cut off";
  if (input.resolved.failures.size) return "edits could not be applied";
  const validation = validateFileOps(input.existing, input.resolved.proposed, input.parsed.deleted);
  if (validation.accepted.size + validation.deletes.size === 0) return "nothing changed";
  const confidence = scoreConfidence({
    status: "complete",
    files: validation.merged,
    warnings: [...validation.warnings, ...validation.rejected.map((rejection) => rejection.reason)],
    incomplete: false,
    edits: input.resolved.stats,
  });
  return confidence.score < MIN_CONFIDENCE_TO_KEEP ? `low confidence (${confidence.score}): ${confidence.reasons[0] ?? ""}` : null;
}
