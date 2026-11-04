import { describe, it, expect, vi } from "vitest";
import { AbortWatcher } from "../abort-watcher";

/**
 * The abort-watcher aborts a run when the user edits/deletes the pending
 * callout header. #29 introduced a second legitimate header
 * (`> [!claude-queued] {query}`) for prompts waiting in the queue — the
 * watcher must accept both, or wiring `checkAllCallouts` to editor changes
 * would spuriously abort every queued prompt.
 */

function makeEditor(lines: string[]) {
	return {
		lineCount: () => lines.length,
		getLine: (n: number) => lines[n] ?? "",
	} as any;
}

function makeWatcher() {
	const abort = vi.fn().mockResolvedValue(undefined);
	const watcher = new AbortWatcher({ abort } as any);
	return { watcher, abort };
}

describe("AbortWatcher.checkSingleCallout header acceptance (#29)", () => {
	it("accepts the pending header", () => {
		const { watcher, abort } = makeWatcher();
		const editor = makeEditor(["> [!claude] pending query", ""]);

		expect(watcher.checkSingleCallout(editor, "callout-1", "pending query", 0)).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("accepts the queued header variant", () => {
		const { watcher, abort } = makeWatcher();
		const editor = makeEditor(["> [!claude-queued] queued query", ""]);

		expect(watcher.checkSingleCallout(editor, "callout-1", "queued query", 0)).toBe(true);
		expect(abort).not.toHaveBeenCalled();
	});

	it("aborts when the header is gone", () => {
		const { watcher, abort } = makeWatcher();
		const editor = makeEditor(["> something else", ""]);

		expect(watcher.checkSingleCallout(editor, "callout-1", "pending query", 0)).toBe(false);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("aborts when the header was edited", () => {
		const { watcher, abort } = makeWatcher();
		const editor = makeEditor(["> [!claude] pending query (edited)", ""]);

		expect(watcher.checkSingleCallout(editor, "callout-1", "pending query", 0)).toBe(false);
		expect(abort).toHaveBeenCalledOnce();
	});

	it("aborts when a queued header was edited", () => {
		const { watcher, abort } = makeWatcher();
		const editor = makeEditor(["> [!claude-queued] queued query (edited)", ""]);

		expect(watcher.checkSingleCallout(editor, "callout-1", "queued query", 0)).toBe(false);
		expect(abort).toHaveBeenCalledOnce();
	});
});
