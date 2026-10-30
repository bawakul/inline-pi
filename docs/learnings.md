# inline-pi — learnings

Running log of hard-won debugging lessons from the inline-pi Obsidian plugin. Each entry: what happened, the real cause, the fix, and what to remember.

> Architecture-direction decisions (which way and why) live in [`decisions/`](./decisions/) as ADRs. This file is for debugging root-causes — "what bit us, the real cause, the fix."

---

## 2026-10-25 · The P6 "spawn wall" was a malformed cwd, not an architecture wall

**Symptom:** `spawn <node> ENOENT` from inside Obsidian's Electron renderer, even for a binary that exists on disk (`/opt/homebrew/opt/node@24/bin/node`). Six commits chased PATH resolution, login-shell PATH probes, and "spawn `node` + `cli.js` directly" before the real cause was found.

**Root cause:** the "Pi working directory" setting held a **shell-escaped path** (`/Users/…/Bawa\'s\ Lab` with literal `\'` and `\ `) that does not exist on disk. Node's `spawn(cmd, args, { cwd })` reports a non-existent `cwd` as `ENOENT` **on the binary**, not on the directory — a famous Node footgun that misleads you into chasing the binary/PATH instead of the directory.

**Reproduction (terminal Node, isolated from Obsidian):**
```js
spawn(node, [], { cwd: "/…/Bawa\\'s\\ Lab" })  // → ENOENT on node (dir doesn't exist)
spawn(node, [], { cwd: "/…/Bawa's Lab" })        // → works
```
Obsidian is NOT sandboxed (only `allow-unsigned-executable-memory` entitlement). The Dock-launched-Obsidian-can't-spawn-external-binaries premise was wrong. The inline-claude `open .command` + localhost-HTTP design was Claude-Code scaffolding, not a sandbox workaround. **Child-process spawn works from Obsidian once the cwd is valid.**

**Fix (commit 220866a):** `pi-client.ts` now validates the cwd exists before spawning and throws `Inline Pi working directory does not exist: "<path>"` instead of letting Node emit the misleading `spawn <node> ENOENT`. Falls back to `process.cwd()` when the setting is blank.

**Lesson:** When `spawn` reports `ENOENT` on a binary you can `ls`, check the `cwd` first. The error names the binary; the cause is the directory.

---

## 2026-10-25 · The settings field is read once at `onload()` — changes go stale (issue #4)

**Symptom:** after fixing the working-directory setting in the UI (plain path in `data.json`), `;;` still failed with the old escaped path. The fix appeared not to work.

**Root cause:** `PiClient` captures `workingDirectory` once in `onload()`:
```ts
const clientOptions = { workingDirectory: this.settings.workingDirectory.trim() || vaultPath, ... };
this.services.piClient = new PiClient(clientOptions);
```
The settings `.onChange` handler mutates `this.settings.workingDirectory` and saves `data.json`, but **never reconstructs the PiClient**. So the running PiClient keeps the value captured at the last `onload` until the plugin is reloaded.

**Workaround:** reload the plugin (disable/enable in Community plugins, or restart Obsidian) after changing the setting.

**Proper fix (filed as #4):** re-read the live `workingDirectory` at each `spawn()` call (the cwd is already passed per-spawn), so the setting takes effect on the next `;;` with no reload.

**Lesson:** any plugin that caches a derived value from settings at construction time must either re-read it at use time or rebuild on change. Settings fields that look "live" but aren't are a silent trap.

---

## 2026-10-25 · "Three pi's spawned" was a miscount — there's one inline-pi pi

**Symptom (Bawa):** "it now spawned three pi's" after a reload.

**Reality:** the inline-pi plugin's `PiClient` is a single shared instance (the D1 design) — it spawns **one** `pi` and reuses it. Each failed spawn (the cwd-ENOENT attempts at 11:01/11:03/11:05) exited via SIGTERM during reloads. After the corrected reload at 12:08, exactly **one** inline-pi pi was alive (child of the Obsidian renderer, PID confirmed via `pgrep -P <renderer>`).

The other `pi` processes in `ps aux | grep pi` were **terminal pi sessions** (parents are `-zsh`), not inline-pi spawns. Verify a pi's parent before killing: inline-pi spawns have `ppid` = an `Obsidian Helper (Renderer)`. Terminal sessions have `ppid` = a shell.

**Lesson:** `ps aux | grep pi` overcounts. Use the process tree (`pgrep -P <parent>`) to attribute a pi to its spawner. The AGENTS.md "never close panes you didn't create" rule applies by analogy: don't kill terminal pi sessions when cleaning up inline-pi spawns.

---

## 2026-10-25 · `;;` with the lab cwd runs a full agentic session, not a quick Q&A

**Symptom:** a 1309-char `;;` prompt in a note, with the working directory set to `Bawa's Lab`, produced a **2.5-minute, 9KB, multi-turn response with tool use** (bash, read). The callout streamed text but gave no indication tools were running.

**Root cause:** the spawned `pi` inherits the **full lab agent config** from the cwd — `AGENTS.md`, skills, MCP servers, the whole `Bawa's Lab` project context. The `--thinking off` flag suppresses only reasoning tokens; it does **not** disable tools or the agent loop. So `;;` "what is X" becomes a full agent run that reads files, runs bash, and takes multiple turns.

**What `--no-session` does and doesn't:** `--no-session` prevents session-file persistence; it does not make pi a stateless Q&A bot. The agent loop, tools, AGENTS.md, skills, and MCP all still load.

**Compounding issue:** the plugin's event handler only routes `message_update` (text deltas) and `agent_settled`. `tool_execution_start/update/end`, `turn_start/end`, `agent_start`, and `message_start` are logged as `unknown event type` and dropped. Tool and extension events arrive with their own UUIDs (not the prompt id `pi-…`), so the per-prompt id-based routing tags them `ignoring event for stale id` and drops them. Net: the callout has **no tool/activity indicator** while the agent works — it looks frozen or just streaming text.

**Decision for testing:** use the **vault root** (a clean cwd with a minimal `AGENTS.md`) as the working directory for inline-pi testing, not `Bawa's Lab`. This keeps the spawned pi a plain Q&A bot without the lab's tools/skills/MCP. (Filed as issues #5 and #6.)

**Lesson:** the cwd is the agent's *entire world*. Pointing inline-pi at a project root loads that project's agent config — tools, skills, MCP, the lot. For inline-note Q&A, either use a stripped cwd, a minimal AGENTS.md, or pi flags that disable tools. `--thinking off` is not enough.

---

## 2026-10-27 · The model imitated prior answers — because the instructions told it to read them

**Symptom:** a `;;ping` came back as `**Claude:** pong — what can I help with?` — the model role-playing the callout wrapper it had seen in the note, while also firing a `read` tool for a one-word question (issue #9's mimicry).

**Root cause:** `INSTRUCTIONS_PREFIX` told the agent to read the file first *including* "any prior `> [!claude]` callout blocks (those are previous Q&A exchanges)." The agent obeyed literally: it read the note, found prior answers, and imitated their format — wrapper label and all.

**Fix:** never ask the agent to go looking for prior answers. `stripCalloutBlocks` in `src/instructions.ts` now **removes** `> [!claude]`/`> [!claude-done]` blocks from the context before it is sent, so the model never sees them.

**Near-miss in the same session (retracted):** an early test appeared to prove *session continuation works* — the agent said "I already have the context from the previous read." Wrong: the agent had read the note file, and the note contained the first attempt's text. Any apparent memory in a `--no-session` agent is text on disk.

**Lesson:** (1) If you point a model at examples, it will imitate them — decide whether that's wanted before making prior answers part of the context. (2) When an agent seems to "remember," find the storage before crediting the mechanism. It's almost always the note, not a session.

---

## 2026-10-28 · "Read the file first" was load-bearing — it was the only thing carrying the question (issue #10)

**Symptom:** after the note context moved into the prompt, `;; weather report for Berlin` produced "I'm ready, type `;;`…" — an answer to no question at all.

**Root cause:** `piClient.prompt()` sent `buildPromptInstructions(...)` — instructions + note context — and the user's query string **never entered the prompt**. It reached pi only because the old instruction told the agent to read the note and find the `;;question` line there. The "roundabout" instruction wasn't decoration; it was the transport. Removing it exposed a latent bug that had existed since M1.

**Fix (commit c0de3ad):** the question is now passed explicitly and appended as a `## Question` section after the note context, threaded from both entry points (`suggest.ts`, `canvas-trigger.ts`).

**Lesson:** before deleting an instruction, ask what data was riding on it. A mechanism that looks like a holdover can be the only path the payload takes.

### Sub-lesson: the test suite was green because it only asserted the half being changed

133 tests passed on functionally broken code. Planner, worker, and review all traced the *context*; nothing traced the *question*. The regression tests that actually guard this (both paths, `suggest.test.ts` / `canvas-trigger.test.ts`) mock `piClient` and assert on the **message that reaches `piClient.prompt`** — the boundary where data crosses into the dependency. **Assert at the boundary, not on the builder's internals; "green" only covers the seam you looked at.**

---

## 2026-10-28 · An off-by-one in a *test* made a fixed bug look re-broken

**Symptom:** while writing the canvas-path regression test for #10, the query arrived as `weather report for Berli` — reading exactly like the production bug being back.

**Root cause:** the test hardcoded `cursor.ch: 27` on a 28-char line. `findCanvasTrigger` does `lineText.substring(0, cursor.ch)`, and `ch` is an index **one past** the last character — so the last letter was cut. The production code was fine; the test's constructed input was wrong.

**Fix:** the test sets `ch: 28` (derived from the line length, with a comment explaining the semantics).

**Lesson:** derive cursors from `line.length`, never a hardcoded index — and when a new test "reproduces the bug," suspect the test's own input before suspecting the code. Tests can lie in both directions.
