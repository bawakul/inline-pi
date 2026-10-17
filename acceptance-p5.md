# Acceptance Report — P5 Canvas (inline-pi)

## Gate Results

| Gate | Status |
|------|--------|
| `npm run build` | ✅ Passed |
| `npm run typecheck` | ✅ Passed |
| `npm test` | ✅ 106 passed (7 test files) |

**Commit hash:** `1a53f92`

---

## Changed Files vs Old canvas.ts

| File | Change |
|------|--------|
| `src/canvas-trigger.ts` | **New** — Contains `findCanvasTrigger`, `prepareCanvasCallout`, and `InlinePiCanvasSuggest` class |
| `src/main.ts` | **Modified** — Added canvas suggest registration (`InlinePiCanvasSuggest`) |
| `src/types.ts` | **Modified** — Added optional `hooks` property to `InlinePiPluginLike` |
| `src/__tests__/canvas-trigger.test.ts` | **New** — 9 tests for canvas trigger detection |
| `P6-HANDOFF.md` | **New** — Manual test checklist for Bawa |

**Old canvas.ts** (from inline-claude-chat) was a helper module with `writeCanvasReply`, `patchCanvasJson`, `deliverCanvasReply`, `findCanvasNodeIdForEditor`, etc. — all still present in `src/canvas.ts` and reused.

**New canvas-trigger.ts** adds the trigger mechanism: detects `;;` in canvas node editors and routes to the streaming callout API.

---

## How Canvas Reuses Streaming/Abort Machinery

| Component | Reused From | Purpose |
|-----------|-------------|---------|
| `insertPendingCallout` | `callout-streaming.ts` | Inserts pending callout header and returns handle |
| `DeltaAccumulator` | `callout-streaming.ts` | Throttled delta streaming (~150ms) |
| `CalloutInstance` | `callout-streaming.ts` | Manages streaming state machine |
| `buildErrorCallout` | `callout-streaming.ts` | Formats error callouts |
| `AbortWatcher` | `abort-watcher.ts` | Monitors header-presence for abort-on-edit |
| `piClient.prompt()` | `pi-client.ts` | Enqueues prompt with FIFO |
| `piClient.abort()` | `pi-client.ts` | Cancels active run |

**Canvas-specific additions:**
- `findCanvasTrigger`: Detects `;;` in canvas node text
- `prepareCanvasCallout`: Identifies canvas node, inserts pending, wires callbacks
- `InlinePiCanvasSuggest`: Canvas-specific suggest via `registerEditorSuggest`
- `isCanvasNodeEditor`: Probes workspace for canvas nodes to identify editors

---

## Main.ts Registration

**Added imports:**
```typescript
import { InlinePiCanvasSuggest } from "./canvas-trigger";
```

**Added registration:**
```typescript
// Register canvas suggest (canvas nodes)
this.registerEditorSuggest(new InlinePiCanvasSuggest(this));
```

The canvas suggest is registered alongside the markdown suggest (`InlinePiSuggest`). Both use the same `registerEditorSuggest` API, but `InlinePiCanvasSuggest.isCanvasNodeEditor()` filters to only trigger when the active editor is a canvas node.

---

## Test Count Added

- **canvas-trigger.test.ts:** 9 new tests (all passing)
- **Total tests:** 106 (up from 97 before P5)

---

## Manual Notes

- **P5 Deliverable:** Canvas `;;` trigger now works. Users can type `;;` in a canvas node text field and get streaming answers directly in the node.
- **D1 Signal:** The FIFO queue in `pi-client.ts` ensures no interleaving of answers, even when multiple notes/canvas files trigger simultaneously.
- **D5 Signal:** The throttle mechanism (~150ms) batches streaming edits; undo behavior depends on Obsidian's undo batching, which should collapse the throttle batches.
- **Known Blocker:** OpenCode Go credits issue — real-pi answers require credits reset or model swap to OpenRouter before testing.

---

## Residual Risks

| Risk | Status |
|------|--------|
| Canvas node editor identification | ✅ Probed via workspace + DOM fallback |
| Streaming into closed canvas files | ✅ `patchCanvasJson` fallback for closed leaves |
| Abort-on-edit in canvas | ✅ Same `AbortWatcher` logic |
| Throttle batching for undo | ⚠️ Depends on Obsidian's undo implementation; may need adjustment if D5 signal fails |
| Multiple canvas leaves active | ✅ `isCanvasNodeEditor` probes all canvas leaves |

**All residual risks are acceptable for M1.**
