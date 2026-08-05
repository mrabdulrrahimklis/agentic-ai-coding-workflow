import { readFile } from "node:fs/promises";
import { callJSON, MODELS } from "./anthropic.js";
import type { Claim } from "./types.js";

const SYSTEM = `You extract falsifiable technical claims from engineering blog drafts.

A claim qualifies ONLY if a machine could prove it wrong today. Examples that
qualify: a stated package version, a CLI flag that either exists or doesn't, an
API response shape, a benchmark number, "X ships with Y enabled by default".

Explicitly does NOT qualify — do not extract these:
- opinions, preferences, recommendations ("I find Aider better for refactors")
- hedged statements ("this tends to", "in my experience", "usually")
- claims about the author's own private work ("our pipeline dropped 40%")
- generic engineering truisms ("smaller diffs are easier to review")

For each claim choose exactly one verification method:
- "exec": there is a runnable snippet whose behaviour settles the claim
- "fetch": a specific public URL would settle it (docs, changelog, spec)
- "registry": it is a package version assertion, resolvable from npm
- "manual": falsifiable in principle but not by these tools

Prefer "manual" over guessing a URL. A fabricated URL is worse than an
unverifiable claim, because it produces a confident false pass.

Reply with JSON only, matching:
{"claims":[{"id":"c001","text":"...","quote":"...","method":"fetch",
"url":"https://...","snippet":{"lang":"bash","code":"..."},
"pkg":{"name":"...","expected":"..."},"confidence":0.0}]}

Include snippet/url/pkg only for the matching method. "quote" must be a verbatim
substring of the draft. Cap at 40 claims; if there are more, keep the ones whose
falsity would most mislead a practitioner.`;

export async function extract(postPath: string): Promise<Claim[]> {
  const post = await readFile(postPath, "utf8");

  const { claims } = await callJSON<{ claims: Claim[] }>({
    model: MODELS.extractor,
    system: SYSTEM,
    user: `<draft path="${postPath}">\n${post}\n</draft>`,
    maxTokens: 8192,
  });

  // Anchor check: drop any claim whose quote isn't actually in the post.
  // The extractor paraphrases under load, and a drifted quote silently breaks
  // the inline annotation in step 3.
  const anchored = claims.filter((c) => post.includes(c.quote));
  const dropped = claims.length - anchored.length;
  if (dropped > 0) {
    console.warn(`[extract] dropped ${dropped} claim(s) with non-verbatim quotes`);
  }

  return anchored.map((c, i) => ({ ...c, id: `c${String(i + 1).padStart(3, "0")}` }));
}
