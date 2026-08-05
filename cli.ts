#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { extract } from "./extract.js";
import { verify } from "./verify.js";
import { gate } from "./gate.js";
import type { Claim } from "./types.js";

/**
 * Each step writes its output to disk before the next one starts. That makes
 * the pipeline resumable (--from verify skips a paid extraction pass) and makes
 * the handoff inspectable when something goes wrong three steps downstream.
 */

async function main() {
  const args = process.argv.slice(2);
  const post = args.find((a) => !a.startsWith("--"));
  if (!post) {
    console.error("usage: claim-check <post.md> [--from extract|verify|gate]");
    process.exit(2);
  }
  const from = (args.find((a) => a.startsWith("--from="))?.split("=")[1] ?? "extract") as
    | "extract"
    | "verify"
    | "gate";

  let claims: Claim[];
  if (from === "extract") {
    claims = await extract(post);
    await writeFile("claims.json", JSON.stringify(claims, null, 2), "utf8");
    console.log(`[extract] ${claims.length} claims`);
  } else {
    claims = JSON.parse(await readFile("claims.json", "utf8"));
    console.log(`[extract] skipped, loaded ${claims.length} claims`);
  }

  let verdicts;
  if (from !== "gate") {
    verdicts = await verify(claims);
    await writeFile("verdicts.json", JSON.stringify(verdicts, null, 2), "utf8");
  } else {
    verdicts = JSON.parse(await readFile("verdicts.json", "utf8"));
  }

  const { report, markdown, blocked } = await gate(post, claims, verdicts);
  console.log(
    `[gate] ${report.counts.pass} pass · ${report.counts.fail} fail · ${report.counts.unverifiable} unverifiable`,
  );

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `\n${markdown}\n`, { flag: "a" });
  }

  process.exit(blocked ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
