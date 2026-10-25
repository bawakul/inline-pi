# Inline Pi

Chat with [pi](https://pi.ai/) inline in your Obsidian notes — type `;;` and get responses as native callout blocks.

> Work in progress: M1 scaffold. Plugin wiring and pi RPC client are coming in later phases.

## Docs

The methodology layer lives in [`docs/`](./docs):

- [`docs/PRD.md`](./docs/PRD.md) — the M1 spec (what's being built, decisions D1–D7, what's in/out of scope).
- [`docs/learnings.md`](./docs/learnings.md) — debugging root-causes (what bit us, the real cause, the fix).
- [`docs/decisions/`](./docs/decisions) — architecture decision records (which way and why). Start with [`0001-spawn-vs-pi-durable.md`](./docs/decisions/0001-spawn-vs-pi-durable.md) (the pi-durable exploration and the spawn-vs-in-process fork).
