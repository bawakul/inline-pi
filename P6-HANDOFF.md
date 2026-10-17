# P6 — Manual Test Checklist (for Bawa)

This document lists the manual tests Bawa should perform in the Obsidian vault to verify P5 (Canvas) and D1/D5 signals.

## Test Environment Setup

1. **Install** the plugin into a test vault (`~/Documents/obsidian-claude-test` or similar)
2. **Configure** `Settings → Inline Pi → Working Directory` to `Bawa's Lab`
3. **Verify** the status bar indicator shows `🟢 Inline Pi` (ready state)

---

## Manual Test Checklist

### 1. Markdown Note Trigger (`;;` in a note)

**Test:** Type `;; What is the capital of France?` in a markdown note and trigger.

**Expected:**
- Pending callout appears: `> [!claude] What is the capital of France?`
- Streaming text appears (throttled ~150ms coalesce)
- Answer settles with green checkmark: `> [!claude-done]+ What is the capital of France?`
- Final content shows Claude's answer

**D1 Signal:** If a second `;;` is typed before the first settles, the second callout should show "queued" status, then answer after the first completes.

---

### 2. Follow-up in Same Note

**Test:** After an answer settles, type `;; And what about Germany?` in the same note.

**Expected:**
- The answer is computed in the same session (piClient maintains session state)
- No "session reset" or loss of context

---

### 3. Canvas Trigger (`;;` in a canvas node)

**Test:** Open a `.canvas` file, type `;; What is the capital of France?` in a text node, and trigger.

**Expected:**
- Pending callout appears in the canvas node: `> [!claude] What is the capital of France?`
- Streaming text appears in the node (throttled ~150ms)
- Answer settles: the pending callout is replaced with the response
- The answer appears directly in the canvas node text

**P5 Deliverable Verified:** Canvas `;;` trigger works and answers stream into node text.

---

### 4. Cancel via Edit (Header Removal)

**Test:** In a markdown note, type `;; test query`, then delete the `> [!claude] test query` header line (or modify it).

**Expected:**
- The callout aborts
- Status changes to "aborted" (red)
- No further streaming occurs

---

### 5. Cancel via Delete (Deletion of Callout)

**Test:** In a markdown note, type `;; test query`, then delete the entire callout block.

**Expected:**
- Same as Cancel via Edit: abort is triggered

---

### 6. Kill-Process Respawn

**Test:** 
1. Start a long-running query
2. While it's streaming, kill the pi process (e.g., `pkill -f pi` or close the terminal running pi)

**Expected:**
- All pending callouts show error state (red)
- Status bar shows `⚫ Inline Pi` (dead)
- On next `;;` trigger, pi respawns automatically
- The new session has fresh memory (no prior conversation)

**D1 Signal Verified:** The client-side FIFO ensures no interleaving of streams after respawn.

---

### 7. Two-Notes-at-Once (D1: Shared Process Signal)

**Test:**
1. Open two separate notes (or canvas files)
2. In Note A: type `;; What is 2+2?` (fast question)
3. In Note B: type `;; What is the weather like today?` (slower, or use a long-running query)

**Expected:**
- Both callouts appear with "pending" status
- Second callout may show "queued" while waiting for pi
- First finishes first, second finishes second
- No interleaving of answers (FIFO ordering maintained)
- Status bar shows `⏳ Inline Pi (1 queued)` during wait

---

### 8. Undo After Streaming (D5: Batched Edits Signal)

**Test:**
1. Type `;; test` in a note and trigger
2. Wait for the answer to appear
3. Press `Ctrl+Z` (or Cmd+Z) multiple times

**Expected:**
- One `Ctrl+Z` should revert to the state BEFORE the callout was inserted
- The intermediate `text_delta` streaming edits should NOT each create an undo step
- If undo batches fail, the throttle may need adjustment or `editor.transaction()` wrapping

---

### 9. Lab Inheritance Signal

**Test:** Ask something that requires lab-specific skills/MCP/memory:

**Example query:** "What is the structure of the `obsidian-claude-chat` directory?" or "Run a command that uses one of your MCP tools"

**Expected:**
- The answer reflects Bawa's Lab environment (full global inheritance)
- MCP tools are available if configured
- Custom instructions/skills in the lab are used

**D3 Signal Verified:** Working directory is `Bawa's Lab`, full inheritance works.

---

## Known Blocker

### OpenCode Go Credits Issue

**Problem:** The `OpenCode Go` model (used by Bawa's Lab pi config) shows `credits: 429d` — this indicates credits are exhausted or the model requires reset.

**Workaround:** Before testing, either:
1. **Reset credits** via the OpenCode dashboard, or
2. **Swap pi default model** to OpenRouter (which has different billing)

**Why this blocks:** Real-pi answers will fail with an error if credits are exhausted.

---

## P5 Canvas Integration Summary

✅ **Canvas trigger** (`;;` in canvas nodes) — implemented via `InlinePiCanvasSuggest`  
✅ **Streaming answer** into node text — reuses `callout-streaming.ts` throttle mechanism  
✅ **Same states** (pending/queued/streaming/green/error/aborted) — mirroring markdown UX  
✅ **Abort-on-edit** watcher — same header-presence check for canvas nodes  
✅ **Node identification** — `findCanvasNodeIdForEditor` with DOM-fallback  
✅ **Response delivery** — `writeCanvasReply` (open leaf) / `patchCanvasJson` (closed leaf)  

---

## Commits

- **P5 Canvas** — `canvas-trigger.ts` new, `main.ts` updated to register canvas suggest, `types.ts` updated with hooks property, `canvas-trigger.test.ts` new
- **Commit with Refs #1** when green
