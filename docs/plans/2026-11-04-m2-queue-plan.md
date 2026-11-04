I now have everything needed: both issue contexts, full reads of `pi-client.ts`, `callout-streaming.ts`, `callout.ts`, `main.ts`, `suggest.ts`, `canvas-trigger.ts`, `abort-watcher.ts`, `styles.css`, the fake-pi harness, and the test suite. Here is the complete plan.

---

# M2: Queue/timeout race (#20) + queued-callout visual state (#29) — implementation plan

**Repo:** `inline-pi` (Obsidian plugin) · **Date:** 2026-11-04 · **Baseline:** 106 tests green (`npm test` = `vitest run`), `npm run typecheck` clean
**Note:** no shell tool was available in this session, so GitHub issue bodies could not be fetched via `gh`; the plan is built from the issue summaries in the task brief, verified line-by-line against the source. One discovered discrepancy with the #29 framing is called out below (§1.4).

## 1. Current state / diagnosis confirmed from source

### 1.1 Issue #20 — timeout→queue race: confirmed, with one refinement

The timeout watchdog lives in `dispatchNext` (`src/pi-client.ts:776–787`):

```ts
req.timeoutHandle = setTimeout(() => {
    this.send({ type: "abort" });          // line 780
    this.settleActive({ ..., error: true, errorMessage: "Response timeout" });
}, this.opts.timeoutMs);
```

Confirmed chain of failure:

1. **`settleActive` (664–678) releases the queue synchronously.** It nulls `this.active`, clears the watchdog, fires `onSettle`, then unconditionally calls `dispatchNext()` (677).
2. **`dispatchNext` (758–792) immediately promotes the next queued prompt** — sets it `active`, arms a new watchdog, and `send()`s it to pi — while pi is still winding down the aborted run. The abort has been *sent*, not *acknowledged*.
3. **Id-gating in `handleLine` (471–485) only covers `message_update` / `message_end`** (`promptScoped`, 477–479; stale-id drop at 480–483) and `response` objects (via `handleResponse`, 599–601). `agent_settled`, `tool_execution_*`, `message_start`, `turn_*`, `agent_start` are session-scoped and attach to whatever `this.active` currently is.
4. **`handleAgentSettled` (627) only guards `if (!this.active) return;` (628).** Post-race, `active` is the *new* prompt, so the old run's late `agent_settled` settles the new prompt: `aborted:true` from the old run, `finalContent` = the new prompt's (empty/partial) buffer. The new prompt's callout renders "Aborted" before producing a single token.
5. **Cascade:** that spurious settle calls `dispatchNext` again → a *third* prompt is sent while the second is still genuinely running at pi.
6. **Stray telemetry confirmed:** `tool_execution_start` (536–540) increments `this.active.toolCount` with no id gate; `message_start` resets `this.active.buffer = ""` — both hit the new prompt during the old run's wind-down.

**Refinements to mattabate's account (discrepancies, all minor):**
- "settles the NEW prompt with its partial buffer" — precise version: the *buffer* is the new prompt's own (empty or near-empty, since the old run's `message_end` content is id-gated and dropped); it's the `aborted:true`/`stopReason` that leaks from the old run. Net effect as reported: the new run is killed.
- Not mentioned in the report, but worsens the cascade: pi may answer the prematurely-dispatched prompt with `disposition:"queued"`, which `handleResponse` explicitly does not handle (614–616, "unexpected queued disposition … keep waiting") — the client then sits with an `active` prompt pi hasn't started, making the subsequent `agent_settled` mis-settle *more* likely, not less.
- The timed-out prompt's *own* settlement is fine (`aborted:false, error:true, "Response timeout"` → red callout immediately). All corruption is downstream of the queue being released early.

### 1.2 The one-line fix shape

The queue must be held from the moment the watchdog fires until the aborted run's `agent_settled` arrives (or a grace period elapses). Confirmed safe to hold: during the hold, `active === null`, and every stray-event path is already null-guarded (`tool_execution_*` at 537/542/547, `message_start` at 527, `activity()` at 315) — so stray wind-down events are harmless *as long as no new prompt becomes active*. That is exactly the invariant to add.

### 1.3 Ordering guarantee that makes this clean

`handleStdoutChunk` (445–457) processes lines synchronously in arrival order, and `settleActive` clears the watchdog (666–669). So the watchdog and a same-run `agent_settled` can never both fire: if settle is parsed first, the timer is gone; if the timer fires first, the late settle hits the new drain branch. No mutex needed.

### 1.4 Issue #29 — discrepancy: the "queued" state is dead code, not just unstyled

- `CalloutState` includes `"queued"` (`src/callout-streaming.ts:21`) and `CalloutInstance.onQueued()` exists (77–81) — but it is a **visual no-op** ("In queued state, keep the pending callout visible") **and is never called in production**: grep shows invocations only in `callout-streaming.test.ts:137`. Neither `suggest.ts` nor `canvas-trigger.ts` calls it. So #29 is *wiring + styling*, not just styling.
- The status-bar `(N queued)` (`src/main.ts:178–180`) is weaker than the issue implies: it's shown only when no detail string is set (`if (det) … else if (d > 0)`), and a busy run almost always has a detail (`thinking…`, tool name, byte count). Also, queue depth is only pushed on status *transitions* (`setStatus` early-return, `pi-client.ts:307–311`), so the count goes stale while busy. With #20's drain holding prompts longer, this staleness becomes more visible — flagged as an optional small fix, not required for #29.
- **Latent landmine found (matters for #29):** the abort-watcher's `checkSingleCallout` (`src/abort-watcher.ts:140–153`) aborts unless the header line *exactly equals* `buildCalloutHeader(query)`. Any queued-state header variant will trip it → spurious `piClient.abort()`. The watcher is currently **dormant** (`checkAllCallouts` is never wired to an editor-change event in `main.ts`, and `handle.abort()` is never called in prod — both verified by grep), but the header change must not bake in a future bug.

## 2. Proposed changes

### Part A — #20: drain state in `src/pi-client.ts` (ships alone)

**New state on `PiClient`:**
- `private draining = false;`
- `private drainTimer: NodeJS.Timeout | null = null;`
- New option `drainGraceMs?: number` on `PiClientOptions` (default `2000`, module const `DEFAULT_DRAIN_GRACE_MS`), folded into `this.opts` in the constructor alongside the existing defaults. Injectable (not a user-facing setting) so tests can use ~100–200 ms.

**Changes by function:**

1. **Watchdog callback (776–787).** Keep `send({type:"abort"})` first. Then: `this.draining = true`; arm `this.drainTimer = setTimeout(() => this.onDrainGraceExpired(req.id), this.opts.drainGraceMs)`; then the existing `settleActive({ …, error:true, errorMessage:"Response timeout" })`. The timed-out prompt's callout still goes red immediately; the queue is now held by (2).
2. **`dispatchNext` (758–759).** Extend the guard: `if (this.active || this.draining || this.queue.length === 0) return;`. Single gate; `settleActive` itself is otherwise unchanged.
3. **`handleAgentSettled` (627–628).** New first branch:
   ```ts
   if (this.draining) { this.endDrain("late agent_settled"); return; }
   ```
   The late settle carries nothing we need — the timed-out prompt already settled with the timeout error — so it's consumed and dropped.
4. **New `private endDrain(reason: string)`:** clear `drainTimer`, `draining = false`, log (`drain complete (${reason}); releasing queue`), `void this.dispatchNext()`.
5. **New `private onDrainGraceExpired(promptId: string)`:** `draining = false; drainTimer = null;` loud log (`drain grace expired for ${promptId}; releasing queue — pi did not acknowledge abort`); `void this.dispatchNext()`.
6. **Hygiene in `failActiveAndQueued` (680) and `shutdown` (821):** clear `drainTimer`/`draining` so a dead client never dispatches from a dangling timer (process exit mid-drain → exit handler → `failActiveAndQueued` → queued prompts already fail there; the timer must not fire afterwards).
7. **`abort()` (794–795):** unchanged behavior (during drain `active === null` → resolves immediately). Add a one-line comment: during drain the abort has already been sent; nothing to do.

No changes to `handleLine` gating, `handleResponse`, or `settleActive` beyond the above. No UI files touched. ~45 lines net.

### Part B — #29 foundation: queued header variant (lands after/with A, independent of styling)

**`src/callout.ts`:**
- Add `buildQueuedCalloutHeader(query): string` → `` `> [!claude-queued] ${query}` `` (mirrors `buildCalloutHeader`, line 8).
- Generalize `findCalloutBlock` (101–104): for a given query, match *either* `` `> [!claude] ${query}` `` or `` `> [!claude] ${query}` ``'s queued twin via a two-marker scan inside `findCalloutRange` (first match wins; end-of-block scan unchanged). Keep the exported `findCalloutRange` signature for other callers. This makes settle-time replacement (`CalloutInstance.replaceWithCallout` → `findCalloutBlock`, `callout-streaming.ts:128–133`) work from the queued look.

**`src/abort-watcher.ts`:**
- `checkSingleCallout` (140–153): accept both canonical headers — abort only if `headerLine !== buildCalloutHeader(query) && headerLine !== buildQueuedCalloutHeader(query)`. Defuses the landmine whether or not the watcher is ever wired.

**`src/callout-streaming.ts`:**
- `CalloutHandle` (23–37): add `onActive(): void` (queued→active flip). Keep `onQueued()`.
- `CalloutInstance.onQueued()` (77–81): implement — guard `state !== "pending"`; set `state = "queued"`; rewrite the header line in place via `replaceWithCallout(buildQueuedCalloutHeader(this.query))`.
- New `CalloutInstance.onActive()`: guard `state !== "queued"`; set `state = "pending"`; rewrite header back to `buildCalloutHeader(this.query)`.
- Wire both into the handle returned by `insertPendingCallout` (206–213).
- `onSettle` (92–125): unchanged — it already replaces the whole block; Part B's `findCalloutBlock` change lets it find the queued header.

### Part C — #29 wiring: drive the state from pi-client events

**`src/pi-client.ts`:**
- `PromptRequest` (70–88): add `onQueued?: () => void`.
- `prompt()` (730–756): after `this.queue.push(req)`, compute `const willQueue = this.active !== null || this.draining;` — if true, call `req.onQueued?.()`; then `this.dispatchNext()` as today. (Cold-start spawn delay is *not* marked queued — the callout keeps the normal pending/spinner look while pi boots; acceptable and simpler.)

**`src/suggest.ts` (157–168) and `src/canvas-trigger.ts` (114–124):**
- Pass `onQueued: () => handle.onQueued()` in the per-prompt handlers alongside the existing `onSettle`.
- In the existing `.then((id) => …)` (which fires on `disposition:"started"`/`"handled"` — the authoritative "pi picked it up"), call `handle.onActive()` before/alongside the current log line.

This gives the exact lifecycle: insert (pending look) → `onQueued` if held (queued look) → `onActive` when pi accepts (pending/active look) → `onSettle` (done/error/aborted). Backward compatible: existing mocks pass handlers they ignore.

### Part D — #29 styling: `styles.css`

New block beside the existing `[data-callout="claude"]` rules (lines 4–16):

```css
.callout[data-callout="claude-queued"] {
  --callout-color: 150, 150, 150;
  --callout-icon: hourglass;
  opacity: 0.65;
  border-left: 3px dashed rgba(150, 150, 150, 0.5);
  background-color: rgba(150, 150, 150, 0.08);
}
.callout[data-callout="claude-queued"] .callout-content { background-color: transparent; }
```

No spin animation (the `claude-spin` rule targets `[data-callout="claude"]` only, so no conflict); the dim + dashed border + hourglass reads as "waiting" next to the spinning active callout. Text stays theme-independent per the existing `claude-done` precedent (25–38).

**Optional (recommend deferring, note in PR):** main.ts status-bar depth staleness — refresh depth in `onPiSettle`/`onPiStatusChange` even when the status enum is unchanged, and don't let `det` mask `(N queued)` while busy. Small, separable.

## 3. Test strategy

**Existing tests that touch the queue/timeout path (must stay green, no changes expected):**
- `src/__tests__/pi-client.test.ts` — "FIFO queue" (304–341, order + depth), "Abort path" (205–224, manual abort, unaffected — manual abort still waits for `agent_settled` before settling, so it never enters drain), "Handled disposition", "Multi-turn", "Activity events".
- **Gap found:** the "Timeout" describe (343–361) *never fires the watchdog* — fake-pi settles in <10 ms against `timeoutMs:100`, and its own comment admits it. The watchdog path at 776–787 is currently **untested**. The new tests below close this.

**fake-pi harness additions (`src/__tests__/fake-pi.ts`, test-only):** the fake currently answers `abort` instantly (last block). Add two scenarios keyed by prompt substring:
- `"slow-abort"`: send `started`; on `abort`, wait ~150 ms, emit stray `tool_execution_start/end` + `message_start` (wind-down noise), *then* `agent_settled{aborted:true}`. Must tolerate never receiving a second prompt (with the fix, none arrives during the wait — that non-arrival is the assertion surface).
- `"never-settle"`: send `started`; ignore `abort` entirely (exercises the grace fallback).

**New `pi-client.test.ts` tests** (using `createClientWithSettleTracking` with `timeoutMs:~100`, `drainGraceMs` per test):
1. **#20 regression — queue held until late `agent_settled`:** prompt A = "slow-abort …", prompt B = "happy". Assert: A settles `error:true / "Response timeout"`; B settles **after** A's delayed settle arrives, with `aborted:false` and `finalContent === "Hello world"` (pre-fix, B settles `aborted:true` with empty content — this assertion *is* the bug). Capture `onActivity`: assert no `"tool"`-phase activity is ever attributed to B (stray wind-down events swallowed while `active === null`).
2. **Grace fallback:** A = "never-settle", `drainGraceMs:~150`, B = "happy". Assert B eventually settles OK and that B's dispatch happened ≥ grace after A's timeout (timestamp ordering).
3. **Multiple queued survivors:** A times out (slow-abort), B and C queued; assert settle order A,B,C and B/C contents correct.
4. **Process exit mid-drain (optional but cheap):** kill the fake during drain; assert queued prompts settle `error:true` and no dangling timer dispatches (test finishes cleanly, no unhandled logs).

**New/updated `callout-streaming.test.ts` tests:**
5. Update "handles queued state" (124–141): `onQueued()` now triggers a second `replaceRange` whose content starts `> [!claude-queued] Queued test`. Use a *stateful* editor mock (make `replaceRange` mutate the lines array — the current mock's static `getLine` would otherwise hide the rewrite from `findCalloutBlock`).
6. `onActive()` rewrites `> [!claude-queued] …` back to `> [!claude] …`.
7. Full lifecycle: pending → queued → active → `onSettle(ok)` produces `[!claude-done]+` (proves `findCalloutBlock` dual-marker matching from the queued header).
8. Guards: `onQueued()` after settle is a no-op; `onActive()` when never queued is a no-op.

**New `callout.test.ts` cases:** `buildQueuedCalloutHeader` format; `findCalloutBlock` matches both header types for the same query and returns correct end-of-block.

**New `suggest.test.ts` case:** capture the handlers passed to the mocked `piClient.prompt`; invoke `handlers.onQueued()` and assert a queued-header `replaceRange`; resolve the mock and assert `handle.onActive()` ran (queued header flipped back). Mirror once in `canvas-trigger.test.ts` if the harness allows, or cover via suggest only.

**New `abort-watcher` coverage (no test file exists today):** small new file — `checkSingleCallout` with a stub `piClient.abort` spy accepts both `[!claude]` and `[!claude-queued]` headers, aborts on anything else.

**Manual vault verification (post-build):** set `timeoutSecs` low (e.g. 5 s) in the lab vault (plugin already symlinked), fire `;;` with a slow question, immediately queue a second `;;`: first callout goes red "Response timeout" at 5 s; second sits dimmed/hourglass; flips to spinner when the drain releases; completes green. Verify no "Aborted" false positive on the second callout.

## 4. Risks and edge cases

- **`agent_settled` never arrives (pi wedged):** grace fallback releases the queue; a *later* settle can still mis-kill the new run — the bug survives in a much narrower window (requires pi to ignore abort for >2 s, then recover). Mitigations: loud log line; `drainGraceMs` documented. Stronger alternative deliberately deferred: kill+respawn pi on grace expiry — blocked by `failActiveAndQueued` failing *queued* prompts too, so a queue-preserving respawn is its own change. Residual risk, accepted.
- **Grace length:** too long → queued prompts feel stuck (the very thing #29 must make legible); too short → leak window widens. 2 s default is a judgment call; aborts on local pi are typically <200 ms.
- **Manual abort during drain:** `abort()` no-ops (`active === null`) — semantically fine (abort already sent). Note: the whole manual-abort path is currently dormant (abort-watcher never wired to editor events; `handle.abort()` uncalled in prod) — pre-existing gap, out of scope, but #20 doesn't preclude wiring it later.
- **Timeout racing a manual abort:** watchdog settles with `error`, so `abort()`'s once-wrapper rejects "prompt settled without abort flag"; both call sites already `.catch`. Noisy console, no corruption.
- **Process exit / shutdown mid-drain:** handled by the `failActiveAndQueued`/`shutdown` timer hygiene (§2A.6); without it a dangling `drainTimer` could dispatch into a respawn.
- **Status bar says "dead" during drain:** `main.ts:onPiSettle` maps any `error` settle to `⚫ dead` (line ~145), and `PiClient.status` stays `"busy"` internally (setStatus never returns to ready after a settle), so the bar can show ⚫ while pi is alive and a prompt is held, then not recover until the next transition. Pre-existing accounting sloppiness, made visible by drain. Recommend the optional main.ts fix or a follow-up issue; don't block #20.
- **Abort-watcher header equality (repeat, because it's a landmine):** shipping Part C's header flip *without* Part B's watcher change means any future wiring of `checkAllCallouts` spuriously aborts every queued prompt. B and C must land together.
- **`onQueued` never fires for the first prompt on cold start** (spawn delay isn't "queued"): acceptable; the spinner look during spawn is honest ("starting").
- **#28 overlap (collapsed-by-default):** touches the same header builders and `findCalloutBlock` marker matching (`+` fold suffix). The `+` sits after `]`, so `startsWith` matching is unaffected, but whichever issue lands second must rebase the marker list. Flag in both PRs; keep this plan's scope to #20+#29.
- **Test determinism:** new timing tests use small but real delays (100–150 ms); the suite already does this (`awaitSettle` polling, `setTimeout` in fake-pi "dialog"), so no new flakiness class is introduced. Keep margins ≥3× the fake's delays.

## 5. Suggested order of implementation

1. **Commit A — #20 (pi-client only, ships independently):** §2A items 1–7 + fake-pi `slow-abort`/`never-settle` + tests 1–4. `npm test` + `npm run typecheck` green. This is the contributor-facing correctness fix; tag mattabate / close #20.
2. **Commit B — #29 foundation:** `callout.ts` dual-marker + `buildQueuedCalloutHeader`, `abort-watcher.ts` dual acceptance, `callout-streaming.ts` `onQueued`/`onActive` implementations + handle type. Tests 5–8 + new abort-watcher file. No behavior change visible yet (`onQueued` still uncalled in prod).
3. **Commit C — #29 wiring:** `PromptRequest.onQueued` + `willQueue` in `pi-client.ts:prompt()`, `suggest.ts` / `canvas-trigger.ts` handler wiring + `onActive()` in `.then()`. Test 9. (Touches the same file as A — trivial adjacency, A lands first.)
4. **Commit D — #29 styling + manual verification:** `styles.css` block; build; lab-vault soak per §3; close #29.

B+C+D can be one PR (#29); A is its own PR (#20). Do not split C from B across PRs (abort-watcher landmine). Optional main.ts status-bar polish: follow-up issue rather than scope creep.

---