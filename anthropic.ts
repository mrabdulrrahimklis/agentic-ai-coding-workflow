import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const MODELS = {
  /** Extraction needs to hold the whole post and reason about what's falsifiable. */
  extractor: process.env.CLAIMCHECK_EXTRACTOR_MODEL ?? "claude-sonnet-5",
  /** The judge sees one claim + one blob of evidence. Small context, high volume. */
  judge: process.env.CLAIMCHECK_JUDGE_MODEL ?? "claude-haiku-4-5-20251001",
};

/** Strip markdown fences the model sometimes adds despite instructions. */
function unfence(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

export async function callText(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const res = await client.messages.create({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    system: opts.system,
    messages: [{ role: "user", content: opts.user }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Call the model and parse strict JSON. Retries once, feeding the parse error
 * back in — cheaper and more reliable than a bare retry, because the second
 * attempt sees what was malformed.
 */
export async function callJSON<T>(opts: {
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<T> {
  const raw = await callText(opts);
  try {
    return JSON.parse(unfence(raw)) as T;
  } catch (err) {
    const repaired = await callText({
      ...opts,
      user:
        `${opts.user}\n\n---\nYour previous reply did not parse as JSON.\n` +
        `Error: ${(err as Error).message}\nPrevious reply:\n${raw}\n\n` +
        `Reply again with valid JSON only. No prose, no fences.`,
    });
    return JSON.parse(unfence(repaired)) as T;
  }
}
