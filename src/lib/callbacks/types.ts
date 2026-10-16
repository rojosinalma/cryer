import type { AnswerView, CallbackSpec } from "../types.ts";

export interface CallbackContext {
  promptId: string;
  title: string;
  answer: AnswerView;
  /** Optional label of the chosen option (for human-readable messages). */
  label: string;
}

export interface CallbackHandler<S extends CallbackSpec = CallbackSpec> {
  /** Reject the spec at prompt creation (throw ValidationError) – e.g. allowlist. */
  validate(spec: S): Promise<void>;
  /** Deliver the answer; throw to fail (already retried inside where it makes sense). */
  deliver(spec: S, ctx: CallbackContext): Promise<void>;
}
