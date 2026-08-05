import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { callJSON, MODELS } from "./anthropic.js";
import type { Claim, Verdict } from "./types.js";

const run = promisify(execFile);
const CONCURRENCY = Number(process.env.CLAIMCHECK_CONCURRENCY ?? 4);
const EVIDENCE_CAP = 6000;

/**
 * The judge sees the claim and the evidence. It does NOT see the post, the
 * surrounding paragraph, or the author's framing — otherwise it reads the
 * author's confidence as evidence and rationalises a pass.
 */
const JUDGE_SYSTEM = `You decide whether a piece of evidence settles a single technical claim.

You will receive a claim and raw evidence (command output, page text, or JSON).
You have no other context and must not assume any.

Return "pass" only if the evidence positively supports the claim.
Return "fail" only if the evidence positively contradicts it.
Return "unverifiable" if the evidence is absent, off-topic, truncated mid-answer,
or merely fails to mention the subject. Silence is not contradiction.

Reply with JSON only: {"status":"pass|fail|unverifiable","rationale":"one line"}`;

async function judge(claim: Claim, evidence: string) {
  return callJSON<{ status: Verdict["status"]; rationale: string }>({
    model: MODELS.judge,
    system: JUDGE_SYSTEM,
    user: `<claim>${claim.text}</claim>\n<evidence>\n${evidence.slice(0, EVIDENCE_CAP)}\n</evidence>`,
    maxTokens: 512,
  });
}

async function execInSandbox(claim: Claim): Promise<Verdict> {
  const { lang, code } = claim.snippet!;
  const dir = await mkdtemp(join(tmpdir(), "claimcheck-"));
  const file = join(dir, lang === "python" ? "s.py" : lang === "bash" ? "s.sh" : "s.mjs");
  await writeFile(file, code, "utf8");
  const cmd = lang === "python" ? "python3" : lang === "bash" ? "bash" : "node";

  try {
    const { stdout, stderr } = await run(cmd, [file], {
      timeout: 30_000,
      maxBuffer: 1 << 20,
      env: { PATH: process.env.PATH ?? "", HOME: dir }, // no secrets into the sandbox
      cwd: dir,
    });
    const evidence = `exit=0\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`;
    const j = await judge(claim, evidence);
    return { claimId: claim.id, ...j, evidence, toolError: false };
  } catch (err: any) {
    // A non-zero exit is real evidence about the snippet, not a tool failure —
    // unless we never got to run it at all.
    const spawnFailed = err.code === "ENOENT";
    const evidence = `exit=${err.code ?? "?"}\n--- stdout ---\n${err.stdout ?? ""}\n--- stderr ---\n${err.stderr ?? err.message}`;
    if (spawnFailed) {
      return {
        claimId: claim.id,
        status: "unverifiable",
        evidence,
        rationale: `no runtime for ${lang}`,
        toolError: true,
      };
    }
    const j = await judge(claim, evidence);
    return { claimId: claim.id, ...j, evidence, toolError: false };
  }
}

async function fetchAndJudge(claim: Claim): Promise<Verdict> {
  try {
    const res = await fetch(claim.url!, {
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
      headers: { "user-agent": "claim-check/1.0 (+ctaio.dev)" },
    });
    if (!res.ok) {
      return {
        claimId: claim.id,
        status: "unverifiable",
        evidence: `HTTP ${res.status} ${res.url}`,
        rationale: "source unreachable",
        toolError: true,
      };
    }
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const j = await judge(claim, `source: ${res.url}\n\n${text}`);
    return { claimId: claim.id, ...j, evidence: text.slice(0, EVIDENCE_CAP), toolError: false };
  } catch (err) {
    return {
      claimId: claim.id,
      status: "unverifiable",
      evidence: String(err),
      rationale: "fetch failed",
      toolError: true,
    };
  }
}

async function checkRegistry(claim: Claim): Promise<Verdict> {
  const { name, expected } = claim.pkg!;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) {
      return {
        claimId: claim.id,
        status: "unverifiable",
        evidence: `HTTP ${res.status}`,
        rationale: "registry lookup failed",
        toolError: true,
      };
    }
    const data: any = await res.json();
    const latest = data["dist-tags"]?.latest;
    const versions = Object.keys(data.versions ?? {});
    const evidence = `latest=${latest}\nexists=${versions.includes(expected)}`;
    // Deterministic: no model call needed, so no judge, so no rationale.
    return {
      claimId: claim.id,
      status: versions.includes(expected) ? "pass" : "fail",
      evidence,
      rationale: "",
      toolError: false,
    };
  } catch (err) {
    return {
      claimId: claim.id,
      status: "unverifiable",
      evidence: String(err),
      rationale: "registry lookup failed",
      toolError: true,
    };
  }
}

async function verifyOne(claim: Claim): Promise<Verdict> {
  switch (claim.method) {
    case "exec":
      return claim.snippet ? execInSandbox(claim) : missingInput(claim, "snippet");
    case "fetch":
      return claim.url ? fetchAndJudge(claim) : missingInput(claim, "url");
    case "registry":
      return claim.pkg ? checkRegistry(claim) : missingInput(claim, "pkg");
    default:
      return {
        claimId: claim.id,
        status: "unverifiable",
        evidence: "",
        rationale: "author review required",
        toolError: false,
      };
  }
}

function missingInput(claim: Claim, field: string): Verdict {
  return {
    claimId: claim.id,
    status: "unverifiable",
    evidence: "",
    rationale: `extractor chose method="${claim.method}" but omitted ${field}`,
    toolError: true,
  };
}

/** Fan out with a small concurrency cap — the judge model rate-limits fast. */
export async function verify(claims: Claim[]): Promise<Verdict[]> {
  const out: Verdict[] = new Array(claims.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, claims.length) }, async () => {
    while (cursor < claims.length) {
      const i = cursor++;
      out[i] = await verifyOne(claims[i]);
      console.log(`[verify] ${claims[i].id} ${out[i].status}`);
    }
  });
  await Promise.all(workers);
  return out;
}
