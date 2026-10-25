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
