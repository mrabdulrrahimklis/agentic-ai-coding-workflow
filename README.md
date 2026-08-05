# claim-check

A three-step agent pipeline that stops unverified technical claims from shipping.

Built for [ctaio.dev](https://ctaio.dev), whose whole positioning is *verifiable
workflow details, low on hype*. That positioning is a liability without
enforcement: one wrong CLI flag in a deep dive and the brand's differentiator is
gone. This makes the differentiator a CI check.

```
draft.md
   │
   ├─▶ [1] extractor agent  (sonnet)   ──▶ claims.json    typed, falsifiable, method-tagged
   │
   ├─▶ [2] verifier         (tools + haiku judge) ──▶ verdicts.json   pass / fail / unverifiable
   │
   └─▶ [3] gate             (deterministic)       ──▶ report + annotated draft + exit code
```

## The steps

**1 — extract.** The draft goes to the extractor with a system prompt whose
bulk is negative space: what *doesn't* count as a claim. Opinions, hedged
statements, and claims about the author's own private numbers are excluded,
because those are the categories that generated the most noise. Output is
`Claim[]`, each one restated as a standalone proposition, anchored to a verbatim
quote, and tagged with exactly one verification method (`exec` / `fetch` /
`registry` / `manual`). The extractor is instructed to prefer `manual` over
guessing a URL — a fabricated source produces a confident false pass, which is
strictly worse than an unchecked claim.

**Handoff:** `claims.json`. Before it's written, every claim whose `quote` is not
a literal substring of the draft is dropped. The extractor paraphrases under
load, and a drifted quote breaks step 3's annotation silently.

**2 — verify.** Fans out over the claims, capped at 4 concurrent. Each method
gets a different tool: `exec` writes the snippet to a temp dir and runs it with
a 30s timeout and a stripped environment; `fetch` pulls the URL and strips it to
text; `registry` hits the npm registry and decides deterministically — no model
call, so no model error.

For `exec` and `fetch`, a **judge agent** decides whether the evidence settles
the claim. The judge receives the claim and the evidence and *nothing else* — not
the post, not the surrounding paragraph, not the author's framing. Given the
paragraph, it reads the author's confidence as evidence and rationalises a pass.

**Handoff:** `verdicts.json`, keyed by claim id.

**3 — gate.** No model runs here, so the publish decision is reproducible from
the artifact alone. Writes a markdown report, a JSON report, and an annotated
copy of the draft with HTML comments spliced in after each non-passing quote
(longest quote first, so nested quotes don't corrupt earlier splices). Exits 1
only on a positive contradiction. `unverifiable` is an author task, not a build
break — gating on it teaches people to delete claims rather than source them,
which inverts the point of the tool.

## Run it

```bash
npm install
export ANTHROPIC_API_KEY=sk-...
npm run check examples/draft-post.md
```

Each step writes its output before the next begins, so you can resume:

```bash
node dist/cli.js examples/draft-post.md --from=verify   # reuse claims.json
node dist/cli.js examples/draft-post.md --from=gate     # reuse verdicts.json
```

In CI, `.github/workflows/claim-check.yml` runs it on changed markdown in a PR,
posts the report as a sticky comment, and fails the check on contradictions.

## The fixture

`examples/draft-post.md` is deliberately mixed: some claims are true, some are
wrong, some are hedged opinions the extractor should *skip*, and one is a private
metric that can't be checked at all. It is not pre-vetted — the point is to run
it and see what the pipeline says, including where the pipeline is wrong about
what the fixture says.

## Config

| env | default | |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | required |
| `CLAIMCHECK_EXTRACTOR_MODEL` | `claude-sonnet-5` | holds the whole post |
| `CLAIMCHECK_JUDGE_MODEL` | `claude-haiku-4-5-20251001` | one claim, one blob, high volume |
| `CLAIMCHECK_CONCURRENCY` | `4` | judge fan-out cap |
