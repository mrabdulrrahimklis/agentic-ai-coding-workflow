import { readFile, writeFile } from "node:fs/promises";
import type { Claim, Report, Status, Verdict } from "./types.js";

/**
 * No model runs in this step. Everything here is deterministic so that the
 * publish decision is reproducible and auditable from the artifact alone.
 */

const MARK: Record<Status, string> = {
  pass: "✅",
  fail: "❌",
  unverifiable: "⚠️",
};

export interface GateResult {
  report: Report;
  annotated: string;
  markdown: string;
  blocked: boolean;
}

export async function gate(
  postPath: string,
  claims: Claim[],
  verdicts: Verdict[],
): Promise<GateResult> {
  const post = await readFile(postPath, "utf8");
  const byId = new Map(verdicts.map((v) => [v.claimId, v]));

  const counts: Record<Status, number> = { pass: 0, fail: 0, unverifiable: 0 };
  for (const v of verdicts) counts[v.status]++;

  // Only a positive contradiction blocks. "unverifiable" is an author task, not
  // a build break — gating on it trains people to delete claims instead of
  // sourcing them, which is the opposite of the point.
  const blocked = counts.fail > 0;

  // Annotate longest-quote-first so nested quotes don't corrupt earlier splices.
  let annotated = post;
  const ordered = [...claims].sort((a, b) => b.quote.length - a.quote.length);
  for (const c of ordered) {
    const v = byId.get(c.id);
    if (!v || v.status === "pass") continue;
    const at = annotated.indexOf(c.quote);
    if (at === -1) continue;
    const note = ` <!-- claim-check ${c.id} ${v.status.toUpperCase()}: ${v.rationale || "see report"} -->`;
    annotated = annotated.slice(0, at + c.quote.length) + note + annotated.slice(at + c.quote.length);
  }

  const rows = claims.map((c) => {
    const v = byId.get(c.id)!;
    return `| ${c.id} | ${MARK[v.status]} ${v.status} | \`${c.method}\` | ${c.text.replace(/\|/g, "\\|")} | ${(v.rationale || "—").replace(/\|/g, "\\|")} |`;
  });

  const markdown = [
    `# claim-check — ${postPath}`,
    ``,
    `**${counts.pass} pass · ${counts.fail} fail · ${counts.unverifiable} unverifiable** — gate: ${blocked ? "**BLOCKED**" : "clear"}`,
    ``,
    `| id | status | method | claim | note |`,
    `| --- | --- | --- | --- | --- |`,
    ...rows,
    ``,
    ...(counts.fail
      ? [
          `## Contradicted`,
          ``,
          ...verdicts
            .filter((v) => v.status === "fail")
            .map((v) => {
              const c = claims.find((x) => x.id === v.claimId)!;
              return `### ${c.id} — ${c.text}\n\n> ${c.quote}\n\n${v.rationale}\n\n<details><summary>evidence</summary>\n\n\`\`\`\n${v.evidence.slice(0, 2000)}\n\`\`\`\n\n</details>`;
            }),
        ]
      : []),
  ].join("\n");

  const report: Report = {
    post: postPath,
    extractedAt: new Date().toISOString(),
    claims,
    verdicts,
    counts,
    gate: blocked ? "blocked" : "clear",
  };

  await writeFile("claim-check-report.md", markdown, "utf8");
  await writeFile("claim-check-report.json", JSON.stringify(report, null, 2), "utf8");
  await writeFile(postPath.replace(/\.md$/, ".annotated.md"), annotated, "utf8");

  return { report, annotated, markdown, blocked };
}
