# ADR 0001: Spawn path vs pi-durable for inline-pi

- **Status:** Proposed — exploring (fork C, see below); not yet committed to either path
- **Date:** 2026-10-25
- **Task:** [tsk T45](https://…) "Look into pi-durable, explore what it allows/improves"
- **Supersedes:** the 2026-10-16 memory note "pi-durable = wrong tool — for building agent apps from scratch, not hosting the full agent" — **retired as stale** (see Context)

## Context

inline-pi today spawns `pi --mode rpc` as a child process (`src/pi-client.ts`, ~856 lines) and talks to it over stdin/stdout JSONL. Open issues from the P6/streaming session (2026-10-25):

- **#7** — no session continuity. `--no-session` starts fresh every reload; inline-claude continued the same Claude, inline-pi does not.
- **#6** — tool/turn events dropped. The plugin hand-routes the RPC event stream by prompt-id; `tool_execution_*`/`turn_*`/`agent_*` events arrived with foreign UUIDs and fell through to `default: unknown event type`. P6 routed them to the status bar, but the routing is hand-rolled and fragile.
- **#4** — settings read once at `onload()`. A working-directory change needs a plugin reload.
- **#5** — `;;` with the lab cwd runs a full agentic session (2.5 min, tool-using), not a quick Q&A. The cwd is the agent's entire world.
- **The P6 "spawn wall"** — a shell-escaped `cwd` value (`Bawa\'s\ Lab`) reported as `ENOENT` on the *binary*; a Node footgun that misleads you into chasing PATH instead of the directory.

`@earendil-works/pi-durable` (v1.4.0, published 2026-10-21) is a **durable agent harness library** you import, not a process you spawn. Conversations, turns, tool calls, and your own state commit to storage *before* anything is shown; `harness.resume()` continues interrupted work after a crash. Backends: Memory, SQLite (Node), **IndexedDB (browser/Electron)**, JSONL, Cloudflare Durable Object. UI-facing APIs: `watchEvents()` (coding-agent-style `message_start`/`message_update`/`tool_execution_*`) and `viewState()` (a Chord state object). Built-in `CodingTools` = read/write/edit/bash. `submit(..., { whenBusy: "steer"|"follow-up"|"reject" })` handles busy conversations. Per-conversation `configure({ extensions, tools, instructions, cwd })`. Auto-compaction. Crash-loop guard.

### The key fact that re-opens the 2026-10-16 call

`@earendil-works/pi-coding-agent` (1.1.0, the CLI inline-pi spawns) **does not depend on pi-durable.** They are siblings, both built on the `pi-ai`/`chord`/`pi-codemode`/`pi-telemetry` primitives. pi-durable is **not** "the pi agent as a library" — it is a *parallel harness kit* for assembling your own agent. So the 2026-10-16 note ("for building agent apps from scratch, not hosting the full agent") is literally still true.

**What changed is the framing, not the fact.** Issue #5 established that a `;;` pointed at `Bawa's Lab` runs a full agentic session, which is the *wrong* default for inline notes; the test vault now uses a stripped cwd. So the thing the spawn path gives "for free" (AGENTS.md/skills/MCP/MEMORY.md/dashboard auto-inheritance) is the thing #5 says you *don't* want by default — and the things the spawn path fights (no durability, hand-routed events, the P6 spawn wall, per-prompt-id routing) are the things pi-durable was built to solve.

## What pi-durable would give inline-pi (mapped to open issues)

- **#7 (session continuity)** — solved for real. Every conversation persists; `harness.resume()` continues interrupted work after Obsidian quits. No more `--no-session` fresh-every-time.
- **#6 (tool/turn events)** — first-class. `watchEvents()` / `viewState()` replace the hand-rolled `PiActivity`/`onActivity`/per-prompt-id routing and the `default: unknown event type` path.
- **The P6 spawn wall** — disappears. pi-durable runs **in-process** (`import`, not `spawn`). No ENOENT, no PATH, no `NODE_BIN_FALLBACKS`, no login-shell sentinel, no "three pi's spawned" miscount, no Dock-launched-Obsidian env chase. ~856 lines of `pi-client.ts` gone.
- **#4 (settings stale at onload)** — evaporates. You'd `configure()` the live harness.
- **D0 (process model, from the PRD)** — re-opens in pi-durable's favor. One harness, many conversations (one per note), `submit(..., { whenBusy })` handles the prompt-while-streaming concern.
- **#5 (full agent vs Q&A)** — becomes a `configure({ extensions, tools, instructions, cwd })` knob per conversation, not a cwd accident.
- **Compaction** — long conversations auto-summarize before the context window (`settings.compaction`), per-model thresholds. inline-pi has nothing for this today.
- **Crash recovery** — `settings.restartLimit`, `onReport`, parked-task handling. The plugin quitting mid-turn loses nothing.

## What it costs

1. **Re-assemble the agent in code.** No "point at `Bawa's Lab`, inherit everything." You configure the model provider (API-key plumbing, not `~/.pi/config.toml`), install `CodingTools` or your own tools, write the system-prompt `sections`. Fine for Q&A; real work to re-port the full lab agent (AGENTS.md loader, skills, MCP). MCP is bridgeable (`api.executeTool("mcp__…")` in the README) but not built-in to the base harness.
2. **"Experimental. The API changes without notice between releases."** (README line 1.) v1.4.0 is 3 days old, 17 versions. The spawn path talks to the CLI over a stable-ish RPC contract; pi-durable is a code import against a moving API.
3. **Bundle weight.** pi-durable unpacks to ~3.5 MB + pi-ai + chord + typebox + diff + photon (WASM, optional). Current inline-pi has zero runtime deps (`obsidian` only). Photon only loads if you import the image tool, but the core is heavier.
4. **Where the harness runs (architecture decision, not blocker).** Obsidian is Electron: renderer (plugin JS) + main (Node). `IndexedDbStorage` runs in the renderer; `openNodeSqliteStorage` and `NodeExecutionEnv` (the file tools) need Node fs → main process. So either harness-in-renderer + IndexedDB + an IPC bridge for file tools, or harness-in-main + SQLite + IPC the UI events back. Both buildable; neither is the "spawn and forget" of today.

## Decision

**Fork C (chosen): explore more before committing.** Not A or B yet.

- **A — stay on the spawn path.** Keep `pi-client.ts`, fix #6 (done) and #7 inside the RPC framing. Lower rewrite, keeps full-agent optionality, but the transport stays fragile and #7 is hard without real session support from the CLI.
- **B — re-scope inline-pi onto pi-durable as an in-process Q&A surface.** Delete the transport layer, get durability + structured events + per-note agent config for free. Lose full-agent-in-a-note (issue #5 becomes "by design"). Take the experimental-API risk and the renderer/main architecture decision.
- **C — explore more before deciding.** Two open questions to answer before A or B:
  1. Does `pi --mode rpc` already expose session resume / durable-ish features that make #7 solvable without pi-durable?
  2. What does a minimal pi-durable inline-pi spike look like in the Obsidian/Electron environment — does IndexedDB-in-renderer + a thin Node env bridge actually work, or is it a yak-shave?

## Consequences

- The 2026-10-16 "pi-durable = wrong tool" memory note is **retired as stale.** It was true against the then-framing (host the full agent); the framing has moved (#5). Do not cite it to dismiss pi-durable for inline-pi again.
- T45 stays open as exploration; the (C) spike is the next concrete step. No code changes yet — this ADR is the record of the exploration and the open fork.
- inline-pi's current architecture (`pi-client.ts` spawn path) stays in place until the (C) questions resolve toward B.

## References

- `@earendil-works/pi-durable` v1.4.0 README — saved to `/tmp/pi-durable-inspect/package/README.md`; npm: https://www.npmjs.com/package/@earendil-works/pi-durable
- Examples 14–31 in `test/examples/` (esp. 14-chat, 16-real-model, 17-coding-tools, 19-json for the event stream, 26-coding-agent for live settings + env-follows-cwd, 29-sandbox-per-conversation for the per-note env question)
- `watchEvents()` and `viewState()` are the UI-facing APIs; `NodeExecutionEnv` + `IndexedDbStorage.open` are the Obsidian-relevant storage/env pair
- `@earendil-works/pi-coding-agent` 1.1.0 (`~/.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-coding-agent`) — the separate stack, confirms pi-durable is a sibling, not the CLI's engine
- The ICM paper lens (arXiv:2603.16021) — this ADR is the methodology layer made inspectable/versioned, the reason this fork lives in git rather than only in memory
- Related issues: #4 (closed), #5 (full agentic run), #6 (tool/turn events), #7 (session continuity)
