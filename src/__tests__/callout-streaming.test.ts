import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile } from "obsidian";
import {
	insertPendingCallout,
	buildErrorCallout,
	type CalloutHandle,
} from "../callout-streaming";
import { PiSettleResult } from "../pi-client";
import { Editor, TFile as MockTFile } from "../__mocks__/obsidian";

// --- Mock helper functions ---

function makeEditorWithLines(lines: string[]) {
	return {
		getLine: (n: number) => lines[n] ?? "",
		lineCount: () => lines.length,
		replaceRange: vi.fn() as any,
		getCursor: vi.fn(() => ({ line: 0, ch: 0 })) as any,
		setCursor: vi.fn() as any,
	} as any;
}

/**
 * A *stateful* editor mock: `replaceRange` actually mutates the backing line
 * array. Required for any test that exercises header rewrites — a static
 * `getLine` would keep returning the old header and hide the rewrite from
 * `findCalloutBlock`, so the assertions would pass (or fail) for the wrong
 * reason. Line-level replacement only; `ch` is ignored, which is all these
 * callouts ever exercise.
 */
function makeStatefulEditor(lines: string[]) {
	return {
		getLine: (n: number) => lines[n] ?? "",
		lineCount: () => lines.length,
		replaceRange: vi.fn(
			(
				replacement: string,
				from: { line: number; ch: number },
				to?: { line: number; ch: number }
			) => {
				const toLine = to ? to.line : from.line;
				lines.splice(from.line, toLine - from.line + 1, ...replacement.split("\n"));
			}
		),
		getCursor: vi.fn(() => ({ line: 0, ch: 0 })),
		setCursor: vi.fn(),
	} as any;
}

function makeTFile(path: string = "test.md"): TFile {
	const f = new MockTFile() as TFile;
	f.path = path;
	return f;
}

// --- Tests for insertPendingCallout ---

describe("insertPendingCallout", () => {
	it("inserts callout header and blank line, returns handle", () => {
		const replaceRange = vi.fn();
		const setCursor = vi.fn();
		const editor = {
			getLine: () => "",
			lineCount: () => 1,
			replaceRange,
			getCursor: () => ({ line: 0, ch: 0 }),
			setCursor,
		} as any;
		const file = makeTFile();

		const handle = insertPendingCallout(editor, file, "What is gravity?");

		expect(handle.id).toMatch(/^callout-/);
		expect(handle.onDelta).toBeTypeOf("function");
		expect(handle.onSettle).toBeTypeOf("function");
		expect(handle.onQueued).toBeTypeOf("function");
		expect(handle.abort).toBeTypeOf("function");

		// Verify replaceRange was called with callout header + 2 blank lines
		expect(replaceRange).toHaveBeenCalledOnce();
		const args = replaceRange.mock.calls[0];
		expect(args[0]).toBe("> [!claude] What is gravity?\n\n");
		expect(args[1]).toEqual({ line: 0, ch: 0 });
		expect(args[2]).toEqual({ line: 0, ch: 0 });

		// Verify cursor was set to line 2 (below header + blank)
		expect(setCursor).toHaveBeenCalledOnce();
		expect(setCursor.mock.calls[0][0]).toEqual({ line: 2, ch: 0 });
	});

	it("wires settle/abort callbacks correctly", () => {
		const editor = makeEditorWithLines([""]);
		const file = makeTFile();

		const handle = insertPendingCallout(editor, file, "Test query");

		// Wire callbacks
		const settleCallback = vi.fn();
		const abortCallback = vi.fn();
		(handle as any).wireSettle(settleCallback);
		(handle as any).wireAbort(abortCallback);

		// Simulate a settle with error result
		const errorResult = {
			finalContent: "",
			aborted: false,
			error: true,
			errorMessage: "Connection failed",
			stopReason: "error",
		};

		handle.onSettle(errorResult as any);

		expect(settleCallback).toHaveBeenCalledOnce();
		expect(settleCallback.mock.calls[0][0]).toBe(errorResult);

		// Simulate abort
		handle.abort();
		expect(abortCallback).toHaveBeenCalledOnce();
	});
});

// --- Tests for CalloutInstance state machine (T42: no streaming) ---

describe("CalloutInstance (no-streaming)", () => {
	it("onDelta is a no-op: the callout stays pending until settle", () => {
		const replaceRange = vi.fn();
		const editor = {
			getLine: (n: number) => ["> [!claude] Test query", "", ""][n] ?? "",
			lineCount: () => 3,
			replaceRange,
			getCursor: () => ({ line: 0, ch: 0 }),
			setCursor: vi.fn(),
		} as any;
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Test query");

		(handle as any).wireSettle(() => {});
		(handle as any).wireAbort(() => {});

		// The initial insert is the only replaceRange call (the pending header).
		expect(replaceRange).toHaveBeenCalledOnce();

		// Deltas must NOT touch the editor — the callout holds its pending header
		// until settle. Live activity is shown in the status bar instead (T42).
		handle.onDelta("Hello");
		handle.onDelta(" world");
		expect(replaceRange).toHaveBeenCalledOnce();
	});

	it("handles queued state", () => {
		const lines = ["> [!claude] Queued test", "", ""];
		const editor = makeStatefulEditor(lines);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Queued test");

		(handle as any).wireSettle(() => {});
		(handle as any).wireAbort(() => {});

		// Mark as queued — this rewrites the header in place (#29).
		handle.onQueued();
		expect(lines[0]).toBe("> [!claude-queued] Queued test");

		// Deltas still do not touch the editor while queued (T42 no-streaming).
		const callsAfterQueue = (editor.replaceRange as any).mock.calls.length;
		handle.onDelta("Processing queued");
		expect((editor.replaceRange as any).mock.calls.length).toBe(callsAfterQueue);
	});

	it("handles aborted state", () => {
		const editor = makeEditorWithLines([
			"> [!claude] Abort test",
			"",
			"",
		]);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Abort test");

		const abortCallback = vi.fn();
		(handle as any).wireSettle(() => {});
		(handle as any).wireAbort(abortCallback);

		// Simulate abort
		handle.abort();

		expect(abortCallback).toHaveBeenCalledOnce();
	});

	it("handles error settle result", () => {
		const editor = makeEditorWithLines([
			"> [!claude] Error test",
			"",
			"",
		]);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Error test");

		const settleCallback = vi.fn();
		(handle as any).wireSettle(settleCallback);
		(handle as any).wireAbort(() => {});

		const errorResult = {
			finalContent: "",
			aborted: false,
			error: true,
			errorMessage: "Provider error",
			stopReason: "error",
		};

		handle.onSettle(errorResult as any);

		expect(settleCallback).toHaveBeenCalledOnce();
		// After settle, callout should be replaced with error callout
		// The replaceWithCallout would be called with buildErrorCallout("Error test", "Provider error")
	});

	it("handles aborted settle result", () => {
		const editor = makeEditorWithLines([
			"> [!claude] Aborted test",
			"",
			"",
		]);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Aborted test");

		const settleCallback = vi.fn();
		(handle as any).wireSettle(settleCallback);
		(handle as any).wireAbort(() => {});

		const abortedResult = {
			finalContent: "Partial response",
			aborted: true,
			error: false,
			stopReason: "stop",
		};

		handle.onSettle(abortedResult as any);

		expect(settleCallback).toHaveBeenCalledOnce();
		// After settle, callout should be replaced with error callout (aborted)
		// The replaceWithCallout would be called with buildErrorCallout("Aborted test", "Aborted")
	});

	it("handles green settle result with content", () => {
		const editor = makeEditorWithLines([
			"> [!claude] Green test",
			"",
			"",
		]);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Green test");

		const settleCallback = vi.fn();
		(handle as any).wireSettle(settleCallback);
		(handle as any).wireAbort(() => {});

		const greenResult = {
			finalContent: "This is the final answer.",
			aborted: false,
			error: false,
			stopReason: "stop",
		};

		handle.onSettle(greenResult as any);

		expect(settleCallback).toHaveBeenCalledOnce();
		// After settle, callout should be replaced with green callout
		// The replaceWithCallout would be called with:
		// "> [!claude-done]+ Green test\n> **Pi:** This is the final answer."
	});

	it("handles green settle result with empty content", () => {
		const editor = makeEditorWithLines([
			"> [!claude] Empty test",
			"",
			"",
		]);
		const file = makeTFile();
		const handle = insertPendingCallout(editor, file, "Empty test");

		const settleCallback = vi.fn();
		(handle as any).wireSettle(settleCallback);
		(handle as any).wireAbort(() => {});

		const emptyResult = {
			finalContent: "",
			aborted: false,
			error: false,
			stopReason: "stop",
		};

		handle.onSettle(emptyResult as any);

		expect(settleCallback).toHaveBeenCalledOnce();
		// After settle, callout should be:
		// "> [!claude-done]+ Empty test\n> **Pi:** "
	});
});

// --- Tests for the queued lifecycle (#29) ---

describe("CalloutInstance queued lifecycle (#29)", () => {
	const green = {
		finalContent: "All done.",
		aborted: false,
		error: false,
		stopReason: "stop",
	};

	it("onQueued rewrites the header to the queued variant", () => {
		const lines = ["> [!claude] Queued test", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Queued test");

		expect(lines[0]).toBe("> [!claude] Queued test");
		handle.onQueued();
		expect(lines[0]).toBe("> [!claude-queued] Queued test");
	});

	it("onActive flips a queued header back to the pending header", () => {
		const lines = ["> [!claude] Queued test", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Queued test");

		handle.onQueued();
		expect(lines[0]).toBe("> [!claude-queued] Queued test");
		handle.onActive();
		expect(lines[0]).toBe("> [!claude] Queued test");
	});

	it("runs the full lifecycle pending → queued → active → done", () => {
		const lines = ["> [!claude] Lifecycle test", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Lifecycle test");

		handle.onQueued();
		handle.onActive();
		handle.onSettle(green as any);

		expect(lines[0]).toBe("> [!claude-done]+ Lifecycle test");
		expect(lines[1]).toBe("> **Pi:** All done.");
	});

	it("settles correctly from the queued state (dual-marker lookup)", () => {
		// The queued header is a different callout type; findCalloutBlock must
		// still locate the block or the settle would silently no-op.
		const lines = ["> [!claude] Queued settle", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Queued settle");

		handle.onQueued();
		expect(lines[0]).toBe("> [!claude-queued] Queued settle");
		handle.onSettle(green as any);

		expect(lines[0]).toBe("> [!claude-done]+ Queued settle");
		expect(lines[1]).toBe("> **Pi:** All done.");
	});

	it("onQueued after settle is a no-op", () => {
		const lines = ["> [!claude] Late queue", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Late queue");

		handle.onSettle(green as any);
		const callsAfterSettle = (editor.replaceRange as any).mock.calls.length;

		handle.onQueued();

		expect((editor.replaceRange as any).mock.calls.length).toBe(callsAfterSettle);
		expect(lines[0]).toBe("> [!claude-done]+ Late queue");
	});

	it("onActive when never queued is a no-op", () => {
		const lines = ["> [!claude] Never queued", "", ""];
		const editor = makeStatefulEditor(lines);
		const handle = insertPendingCallout(editor, makeTFile(), "Never queued");

		handle.onActive();

		// Only the initial insert — no header rewrite.
		expect(editor.replaceRange).toHaveBeenCalledOnce();
		expect(lines[0]).toBe("> [!claude] Never queued");
	});
});

// --- Tests for buildErrorCallout ---

describe("buildErrorCallout", () => {
	it("formats error callout correctly", () => {
		const result = buildErrorCallout("What is X?", "Connection refused");
		expect(result).toBe("> [!claude] What is X?\n> ⚠️ Connection refused");
	});

	it("handles multi-line error message (first line only)", () => {
		// Note: errorMsg is inserted as-is, so newlines are preserved but
		// only the first line gets the > ⚠️ prefix
		const result = buildErrorCallout("Query", "Error line 1\nError line 2");
		expect(result).toBe("> [!claude] Query\n> ⚠️ Error line 1\nError line 2");
	});
});
