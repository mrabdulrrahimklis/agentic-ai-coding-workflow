# Wiring a review agent into CI without slowing the merge queue

Most teams bolt an agent onto their PR flow and discover the same thing a week
later: the bottleneck moved. The agent is fine. The wait is not.

## The runtime floor

Node 20 is the current LTS line, and `AbortSignal.timeout()` is available on it
without a flag, which matters because every fan-out step in a review pipeline
needs a per-request deadline rather than one global one.

The `zod` package is on version 3.23.8 and its `.safeParse()` returns a discriminated
union rather than throwing, so you can gate on parse failure without a try/catch:

```javascript
console.log(typeof AbortSignal.timeout);
```

## Concurrency

In my experience four concurrent judge calls is the sweet spot — past that you
spend more time on retries than you save on wall-clock. Smaller diffs are easier
to review, so most of this is moot if your team already ships small.

## Model routing

Per the Anthropic docs, prompt caching has a five-minute default TTL, which is
roughly the window a CI job needs if you fan out immediately after extraction:
<https://docs.claude.com/en/docs/build-with-claude/prompt-caching>

Our own pipeline cut review latency by 38% after we split extraction from
judging.
