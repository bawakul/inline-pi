# Inline Pi

Chat with [pi](https://pi.ai/) inline in your Obsidian notes. Type `;;` where you're writing and the answer comes back as a native callout block — the note is the conversation.

A port of [inline-claude](https://github.com/bawakul/inline-claude) to the pi agent harness: same itch (ask about what you're writing, without leaving the note), new engine (pi over RPC, whatever model your pi runs).

<!-- demo GIF goes here — assets/demo.gif, ~15s: ;; question → status bar activity → callout settles (tsk T62) -->

<!-- BAWARESECTION: The idea — yours to write. Reference material from inline-claude's README:
     the "driver's seat" framing ("you're writing — your thoughts, your notes, your flow —
     and the assistant is just there when you need it… the AI fits into your environment,
     not the other way around") + the malleable-software link
     (https://www.geoffreylitt.com/2023/03/25/llm-end-user-programming.html).
     Adapt to inline-pi's story: no channel server, any provider, the note is the context. -->

## How it works

- Type `;; your question` on a line in any note
- A pending callout marks the question; the status bar shows what pi is doing (spawning, thinking, running a tool, streaming)
- The note around your cursor travels with the question, so answers are about what you're actually writing
- The answer settles in as a collapsible callout titled with your question
- The thread is persistent — reload Obsidian, reopen the vault, kill the pi process: the next `;;` continues the same conversation. **Inline Pi: Start fresh thread** (command palette) sheds a stale thread without losing it — the old one stays on disk

## Requirements

- [Obsidian](https://obsidian.md/), desktop only
- A local [pi](https://pi.ai/) install, logged in — pi runs the model, so the provider and model are configured in pi, not in this plugin
- `node` reachable on your login shell PATH (the plugin spawns node + pi's CLI directly)
- Whatever your pi talks to — no specific subscription or API is required by the plugin itself

## Setup

Personal-tool stage: no releases, no installer, no plugin store. You build it.

1. Clone the repo
2. `npm install && npm run build`
3. Link or copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/inline-pi/` (a symlink works — the plugin always runs what you build)
4. Obsidian → Settings → Community plugins → enable **Inline Pi**
5. Optional: set a working directory in the plugin settings (see below)

## Settings

| Setting | Default | What it does |
|---------|---------|--------------|
| Trigger phrase | `;;` | Text that opens the question prompt |
| Pi working directory | *(blank = vault root)* | Passed to pi as its cwd. Point it at a project folder and pi inherits that project's `AGENTS.md`, memory, skills, and MCP servers |
| Response timeout | `300` s | How long to wait before timing out |
| Enable debug log | on | Writes a full event trace to `~/.pi/inline-pi-debug.log` |
| Session id | *hidden — generated on first load* | Stable id for this vault's `;;` thread (`data.json` → `sessionId`). Delete the key to fall back to one-shot sessions — no rebuild needed |

## What it writes to your vault

**Nothing.** No `.mcp.json`, no `CLAUDE.md`, no channel server script — the plugin never modifies your vault's config or content on its own. (That was the old inline-claude architecture; the port removed all of it.)

What does exist:

- Plugin settings live in Obsidian's standard `.obsidian/plugins/inline-pi/data.json`
- The debug log (if enabled) writes to `~/.pi/inline-pi-debug.log` — outside the vault
- The vault's `;;` thread persists as a session file under `~/.pi/agent/sessions/…` (outside the vault, prefixed `inline-pi-`) — same place terminal pi sessions live, so old threads are resumable from the terminal with `pi --resume`

## Security & trust model

**Be honest about what this is.** A `;;` question hands your prompt — plus the note text around your cursor — to a full pi agent running with your pi's tool access.

**What pi can do through this plugin:**

- Read and write files (not just inside your vault)
- Run shell commands
- Search the web

…whatever your pi configuration allows. The plugin doesn't restrict pi's toolset.

**What the plugin is: a transparent pipe.** It spawns `pi --mode rpc` per question, sends one payload (instructions + note context + your question), and renders the response as a callout. There is exactly **one** instruction source — `INSTRUCTIONS_PREFIX` in [`src/instructions.ts`](./src/instructions.ts) — sent verbatim with every prompt. Nothing hidden, no vault-level instruction files.

**What the plugin does NOT do:**

- No telemetry, no analytics, no external network calls of its own
- No background processing — every interaction starts with you typing `;;`
- No writes to your vault (see above)

**Prompt injection is a real risk.** The note around your cursor travels with every question — so web clips, imports, or shared notes containing hostile instructions will reach the model. That's inherent to any LLM reading untrusted text; the practical guardrail is what your pi is allowed to touch.

**The working-directory setting is a trust surface too.** Pointing it at a project folder means pi loads that project's `AGENTS.md`, memory, and skills on every `;;` — powerful, but it's you vouching for that folder's contents.

> **If you wouldn't run pi in a directory, don't `;;` in a note in that vault.**

<!-- BAWARESECTION: The log so far — yours to rework. Current draft entries below;
     rewrite in your voice, keep the beats you want. -->

## The log so far

A running record of the build, in plain words. Root-causes and decision records live in [`docs/`](./docs).

- **Oct 17 — the port.** M1: same user-facing behavior as inline-claude, on pi. Scaffold, the client that talks to pi, settings, status bar, canvas triggers.
- **Oct 23 — the spawn wall.** Obsidian couldn't start pi at all — a maze of PATH and environment problems that took three fixes to climb (login-shell PATH, spawning node directly, validating the working directory before launch). Behind it a second wall: pi was answering, but the answers never reached the note — the wiring between pi and the callout simply wasn't connected. We added a file debug log (`~/.pi/inline-pi-debug.log`) and live status-bar states so nothing is invisible again.
- **Oct 25 — quieter callouts.** Stopped streaming tokens into the note mid-thought; the answer now arrives whole, once it's done. Changing the working-directory setting now reaches a running client without a reload.
- **Oct 28 — the question that never arrived.** The plugin was sending pi the instructions and the note context… but not the actual question. Fixed. Also retired "read the file first" — the note now travels inside the prompt itself, so a trivial question stays trivial.
- **Oct 29 — telling the model what it is.** The instruction prefix still claimed the assistant was Claude and never mentioned it could search the web — asked about weather, it confabulated that it "runs without tools by design." Rewritten to state what it actually has. The manual test checklist passed in the test vault end to end. The answer callout also stopped introducing itself as Claude — the label reads **Pi:** now.
- **Nov 20 — threads that stay.** `;;` conversations used to live only in RAM: restart Obsidian and the thread was gone, no trace on disk. Now every vault gets one persistent session — reloads, crashes and restarts all reattach to the same conversation, and a palette command starts a fresh thread without losing the old one (it stays on disk, resumable from the terminal).

## Rough edges

Honest state, so nobody has to discover these the hard way:

- `;;` in **canvas nodes is broken** — the suggestion popup dead-ends ("selectSuggestion called without a file") and nothing happens. It has never worked live — only unit tests ever exercised it ([#18](https://github.com/bawakul/inline-pi/issues/18))
- A long-lived thread carries everything you've ever asked it in that vault — when it turns stale or heavy, **Inline Pi: Start fresh thread** sheds it (the old session file stays on disk)
- Two Obsidian windows on the same vault would write to one session file — untested, no locking
- A one-word question can still trigger a full agent run — slower than it should be
- Personal-tool stage: no releases, no installer — clone, build, bring your own pi

## Docs

- [`docs/PRD.md`](./docs/PRD.md) — the M1 spec (what's being built, decisions D1–D7, scope)
- [`docs/learnings.md`](./docs/learnings.md) — debugging root-causes: what bit us, the real cause, the fix
- [`docs/decisions/`](./docs/decisions) — architecture decision records; start with [`0001-spawn-vs-pi-durable.md`](./docs/decisions/0001-spawn-vs-pi-durable.md)
- [`docs/architecture.md`](./docs/architecture.md) — how a `;;` keystroke becomes a callout, traced through the code
