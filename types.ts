/**
 * The contract between pipeline steps.
 *
 * Step 1 (extract) emits Claim[]. Step 2 (verify) consumes Claim[] and emits
 * Verdict[]. Step 3 (gate) consumes Verdict[] and emits a report + exit code.
 *
 * Steps communicate ONLY through these shapes. No step reads another step's
 * prompt, and the judge in step 2 never sees the source post — see verify.ts.
 */

export type VerificationMethod =
  | "exec" // run the snippet in a sandbox, compare behaviour to the claim
  | "fetch" // pull a URL and judge whether it supports the claim
  | "registry" // resolve a package version from the npm registry
  | "manual"; // not machine-checkable; surfaced to the author, never fails the gate

export interface Claim {
  /** Stable id, assigned by the extractor: c001, c002, ... */
  id: string;
  /** The claim restated as a standalone falsifiable proposition. */
  text: string;
  /** Verbatim span from the post, used to anchor the inline annotation. */
  quote: string;
  method: VerificationMethod;
  /** Populated for method === "exec". */
  snippet?: { lang: string; code: string };
  /** Populated for method === "fetch". */
  url?: string;
  /** Populated for method === "registry". */
  pkg?: { name: string; expected: string };
  /** Extractor's own confidence that this is a real, checkable claim. */
  confidence: number;
}

export type Status = "pass" | "fail" | "unverifiable";

export interface Verdict {
  claimId: string;
  status: Status;
  /** Raw evidence gathered by the tool: stdout, HTTP body excerpt, registry JSON. */
  evidence: string;
  /** The judge's one-line rationale. Empty for deterministic methods. */
  rationale: string;
  /** Whether the tool itself errored (network, sandbox, 404) vs. the claim being wrong. */
  toolError: boolean;
}

export interface Report {
  post: string;
  extractedAt: string;
  claims: Claim[];
  verdicts: Verdict[];
  counts: Record<Status, number>;
  gate: "blocked" | "clear";
}
