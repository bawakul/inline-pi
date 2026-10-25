# inline-pi — M1 Spec

**Milestone 1: clean port of inline-claude to pi — same user-facing functionality, new engine.** Use it first, rethink it second. The v0.2 "rebuild" questions are settled for M1; the rethink (permission gate, model UX, etc.) is later work.

- Work issue: [bawakul/inline-pi#1](https://github.com/bawakul/inline-pi/issues/1) — parity checklist + decision table with evaluation signals
- Retro issue: [bawakul/inline-pi#2](https://github.com/bawakul/inline-pi/issues/2) — what we learned / what to change, filled after real usage
- Old plugin (behavior parity reference): `obsidian-claude-chat/` in the lab root → [bawakul/inline-claude](https://github.com/bawakul/inline-claude) (stays public and active)

---

## 1. What this is

An Obsidian plugin where you type `;;` in any note, ask a question, and the answer appears as a callout block in the note — powered by **pi running headless** (`pi --mode rpc`). No sidebar, no chat window, no context-switching. The note is the conversation.

Philosophy is carried over unchanged from inline-claude (P1–P5: driver's seat, note-is-conversation, transparent pipe, malleable, local).

## 2. Architecture

```
┌─ Obsidian ────────────────────────────────────────────────┐
│  type ;;  →  EditorSuggest dropdown  →  Enter             │
│  ① active note saved (dirty buffer flushed)               │
│  pending callout inserted at cursor                        │
│  prompt + basic instructions → pi's stdin ──┐             │
│                                             │ stdin (JSONL)
│  events from pi's stdout ◀──────────────────┘             │
│   ├─ text_delta → callout body fills in (throttled)        │
│   ├─ error/abort → callout turns error-red                 │
│   └─ agent settles → callout finalized (green)             │
└───────────────────────────────────────────────────────────┘
                    │  cwd = configured working directory
                    ▼
        pi --mode rpc                  ← ONE shared hidden process
        • default cwd: the vault; Bawa sets it to Bawa's Lab
        • single rolling session — one continuous conversation
        • full tools: read/write/edit/bash + skills, memory, MCP
        • note is outside cwd? no problem — prompt carries the
          absolute path; pi reads it with its own tools
        • dies? → pending callouts flip to error, respawn on next ;;
```

**What dies from inline-claude:** the Bun channel server, HTTP polling, `.mcp.json` writes, CLAUDE.md injection, the visible Terminal.app spawn, reply-store polling. The plugin talks to pi directly over stdin/stdout JSONL.

## 3. How it works — mechanics

- **Spawn on demand.** First `;;` spawns one hidden pi process for the vault; every question reuses it. Dead process → pending callouts go error-red, next `;;` respawns.
- **Single rolling session.** All questions across all notes flow into one continuous conversation (parity with the old plugin's live claude instance). The note's callout blocks remain the rendered truth — pi is told to read them as history.
- **Per-prompt instructions.** Every prompt carries: the note's absolute path, cursor line, and the core behavior instructions inline (read the file first, callout blocks are history, be concise, start with text). **Nothing is written anywhere** — no AGENTS.md auto-write, no CLAUDE.md injection, no files touched outside the note itself. The plugin is a self-contained pipe (P3 at its purest).
- **Working directory is a setting.** Default: the vault root. Bawa's setup: `~/Documents/Bawa's Lab`, so `;;` inside the real vault is answered by the lab's pi — with the lab's context, skills, and his full global pi setup (memory, MCP servers, default model).
- **Streaming.** `text_delta` events fill the callout body as the answer generates, throttled (~150 ms coalesce) so the editor is never thrashed. Settle → green, collapsible. This is the one deliberate deviation from exact parity.
- **Save-before-prompt.** pi reads the file from disk; the plugin saves the active note first so the agent never answers about stale text.
- **Cancel.** Editing/deleting a pending callout's prompt line → `abort` on stdin; a stuck answer can always be stopped without leaving the note.
- **PATH resolution.** Obsidian launched from Dock doesn't inherit shell PATH — read PATH once from `$SHELL -i -l`, plus fallback locations. (Kills old issue #1's whole bug class.)
- **JSONL framing, strictly.** Split on LF only, never `readline` (Unicode separators are legal inside JSON strings); read stdout continuously or the pipe stalls; watch stderr for diagnostics but never parse it as protocol.

## 4. What survives from inline-claude (porting base)

| Survives (ported) | Notes |
|---|---|
| `suggest.ts` — `;;` trigger + dropdown | near-unchanged |
| `callout.ts` — callout insert | gains streaming + error/abort states |
| `canvas.ts` — canvas support | ported as-is |
| settings surface | slimmer: trigger phrase, working directory, timeout |
| **new `pi-client.ts`** | ~250 lines: spawn, JSONL framing, event dispatch, lifecycle |

## 5. Decisions locked for M1 (2026-10-17 scoping session)

| # | Decision |
|---|----------|
| D1 | Shared process — one pi for the vault |
| D2 | Single rolling session — one continuous conversation |
| D3 | Configurable working directory (default vault; Bawa → Bawa's Lab) |
| D4 | Per-prompt instructions only — nothing written to any AGENTS.md |
| D5 | Streaming answers in M1 (the one parity deviation) |
| D6 | Full global inheritance (memory, skills, MCP, default model) |
| D7 | Fresh private repo `bawakul/inline-pi`; inline-claude stays public/active |

Each decision has a "what to watch for" signal in [#1](https://github.com/bawakul/inline-pi/issues/1); the verdicts land in the [#2 retro](https://github.com/bawakul/inline-pi/issues/2) after real usage.

## 6. Out of scope (M1)

Permission-gate extension (v2), model picker UI, lean/scoped mode toggle, chat surfaces of any kind, mobile, other harnesses.

---

*History: v0.1–v0.2 were the rethink draft (2026-10-16, kimi-k3-reviewed). v1.0 M1 spec rewritten 2026-10-17 after the scoping session with Bawa — "clean port first, rethink second."*
