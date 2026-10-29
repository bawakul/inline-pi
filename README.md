# Inline Pi

Chat with [pi](https://pi.ai/) inline in your Obsidian notes. Type `;;` where you're writing and the answer comes back as a native callout block — the note is the conversation.

A port of [inline-claude](https://github.com/bawakul/inline-claude) to the pi agent harness: same itch (ask about what you're writing, without leaving the note), new engine (pi over RPC, whatever model your pi runs).

<!-- demo GIF goes here — assets/demo.gif, ~15s: ;; question → status bar activity → callout settles -->

## How it works

- Type `;; your question` on a line in any note — works on canvas nodes too
- A pending callout marks the question; the status bar shows what pi is doing (spawning, thinking, running a tool, streaming)
- The note around your cursor travels with the question, so answers are about what you're actually writing
- The answer settles in as a collapsible callout titled with your question

Desktop Obsidian only. Needs a local pi install — it speaks to pi, pi speaks to the model.

## The log so far

A running record of the build, in plain words. Root-causes and decision records live in [`docs/`](./docs).

- **Oct 17 — the port.** M1: same user-facing behavior as inline-claude, on pi. Scaffold, the client that talks to pi, settings, status bar, canvas triggers.
- **Oct 23 — the spawn wall.** Obsidian couldn't start pi at all — a maze of PATH and environment problems that took three fixes to climb (login-shell PATH, spawning node directly, validating the working directory before launch). Behind it a second wall: pi was answering, but the answers never reached the note — the wiring between pi and the callout simply wasn't connected. We added a file debug log (`~/.pi/inline-pi-debug.log`) and live status-bar states so nothing is invisible again.
- **Oct 25 — quieter callouts.** Stopped streaming tokens into the note mid-thought; the answer now arrives whole, once it's done. Changing the working-directory setting now reaches a running client without a reload.
- **Oct 28 — the question that never arrived.** The plugin was sending pi the instructions and the note context… but not the actual question. Fixed. Also retired "read the file first" — the note now travels inside the prompt itself, so a trivial question stays trivial.
- **Oct 29 — telling the model what it is.** The instruction prefix still claimed the assistant was Claude and never mentioned it could search the web — asked about weather, it confabulated that it "runs without tools by design." Rewritten to state what it actually has. The manual test checklist passed in the test vault end to end. The answer callout also stopped introducing itself as Claude — the label reads **Pi:** now.

## Rough edges

Honest state, so nobody has to discover these the hard way:

- Every `;;` starts a fresh session — no conversation continuation yet
- A one-word question can still trigger a full agent run — slower than it should be
- Personal-tool stage: no releases, no installer — clone, build, bring your own pi

## Docs

- [`docs/PRD.md`](./docs/PRD.md) — the M1 spec (what's being built, decisions D1–D7, scope)
- [`docs/learnings.md`](./docs/learnings.md) — debugging root-causes: what bit us, the real cause, the fix
- [`docs/decisions/`](./docs/decisions) — architecture decision records; start with [`0001-spawn-vs-pi-durable.md`](./docs/decisions/0001-spawn-vs-pi-durable.md)
- [`docs/architecture.md`](./docs/architecture.md) — how a `;;` keystroke becomes a callout, traced through the code
