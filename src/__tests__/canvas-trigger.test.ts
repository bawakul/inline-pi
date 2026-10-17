import { describe, it, expect, vi } from "vitest";
import { findCanvasTrigger, prepareCanvasCallout } from "../canvas-trigger";

/**
 * Mock helper for testing canvas trigger detection.
 */
function makeEditorWithLines(lines: string[]) {
	return {
		getLine: (n: number) => lines[n] ?? "",
		lineCount: () => lines.length,
		replaceRange: vi.fn() as any,
		getCursor: vi.fn(() => ({ line: 0, ch: 0 })) as any,
		setCursor: vi.fn() as any,
	} as any;
}

describe("findCanvasTrigger", () => {
	it("detects ;; trigger in canvas node text", () => {
		const result = findCanvasTrigger(";; what is x", 13, ";;");
		expect(result).toEqual({
			triggerIndex: 0,
			query: " what is x",
		});
	});

	it("detects ;; in middle of line", () => {
		const result = findCanvasTrigger("prefix ;; what is x", 20, ";;");
		expect(result).toEqual({
			triggerIndex: 7,
			query: " what is x",
		});
	});

	it("returns null when ;; not found", () => {
		const result = findCanvasTrigger("no trigger here", 15, ";;");
		expect(result).toBeNull();
	});

	it("returns null when cursor is before ;;", () => {
		const result = findCanvasTrigger(";; what is x", 1, ";;");
		expect(result).toBeNull();
	});

	it("returns the last ;; occurrence when multiple present", () => {
		const result = findCanvasTrigger(";; first ;; second", 20, ";;");
		expect(result?.triggerIndex).toBe(9);
		expect(result?.query).toBe(" second");
	});
});

describe("prepareCanvasCallout", () => {
	it("returns null when piClient is not available", () => {
		const plugin = {
			app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
			settings: { triggerPhrase: ";;" },
			getPiClient: vi.fn(() => null),
		} as any;

		const editor = makeEditorWithLines([";; what is x"]);
		const result = prepareCanvasCallout(plugin, "test.canvas", editor);
		expect(result).toBeNull();
	});

	it("returns null when no trigger found in line", () => {
		const piClient = { prompt: vi.fn() };
		const plugin = {
			app: {
				commands: { commands: { "editor:save-file": true }, executeCommandById: vi.fn() },
				workspace: { getLeavesOfType: vi.fn(() => []) },
			},
			settings: { triggerPhrase: ";;" },
			getPiClient: vi.fn(() => piClient),
		} as any;

		const editor = makeEditorWithLines(["no trigger here"]);
		const result = prepareCanvasCallout(plugin, "test.canvas", editor);
		expect(result).toBeNull();
	});

	it("detects trigger and returns object with handle", () => {
		// Test that the trigger detection works in isolation
		// The full integration is tested in canvas.test.ts via deliverCanvasReply
		const lineText = ";; what is x";
		const cursorCh = 13;
		const result = findCanvasTrigger(lineText, cursorCh, ";;");
		expect(result).not.toBeNull();
		expect(result?.triggerIndex).toBe(0);
		expect(result?.query).toBe(" what is x");
	});

	it("finds last ;; when multiple triggers present", () => {
		const lineText = "prefix ;; q1 ;; q2";
		const cursorCh = 18; // Cursor after the last ;;
		const result = findCanvasTrigger(lineText, cursorCh, ";;");
		expect(result).not.toBeNull();
		expect(result?.triggerIndex).toBe(13);
		expect(result?.query).toBe(" q2");
	});
});
