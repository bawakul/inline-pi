import { describe, it, expect, vi } from "vitest";
import { findTrigger, InlinePiSuggest } from "../suggest";
import { App, Editor, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";

describe("findTrigger", () => {
	it('detects ;; at the start of line with content after', () => {
		const result = findTrigger(";;hello", 7, ";;");
		expect(result).toEqual({ triggerIndex: 0, query: "hello" });
	});

	it('detects ;; in the middle of a line', () => {
		const result = findTrigger("some text ;;question", 20, ";;");
		expect(result).toEqual({ triggerIndex: 10, query: "question" });
	});

	it('returns null when trigger is absent', () => {
		const result = findTrigger("no trigger here", 15, ";;");
		expect(result).toBeNull();
	});

	it('returns empty query when only trigger is typed', () => {
		const result = findTrigger(";;", 2, ";;");
		expect(result).toEqual({ triggerIndex: 0, query: "" });
	});

	it('works with custom trigger phrase', () => {
		const result = findTrigger("text ??question", 15, "??");
		expect(result).toEqual({ triggerIndex: 5, query: "question" });
	});

	it('uses last occurrence of trigger phrase', () => {
		const result = findTrigger(";;first ;;second", 16, ";;");
		expect(result).toEqual({ triggerIndex: 8, query: "second" });
	});

	it('only considers text before cursor', () => {
		const result = findTrigger("hello ;;world", 5, ";;");
		expect(result).toBeNull();
	});

	it('handles single-char trigger', () => {
		const result = findTrigger("text /ask pi", 12, "/");
		expect(result).toEqual({ triggerIndex: 5, query: "ask pi" });
	});

	it('handles longer trigger phrase', () => {
		const result = findTrigger("text :::pi question", 19, ":::");
		expect(result).toEqual({ triggerIndex: 5, query: "pi question" });
	});
});

describe("InlinePiSuggest selectSuggestion", () => {
	it("inserts a pending callout and places the cursor below it", () => {
		const app = new App();
		const plugin = {
			app,
			settings: { ...DEFAULT_SETTINGS },
		};
		const suggest = new InlinePiSuggest(plugin as any);

		const replaceRange = vi.fn();
		const setCursor = vi.fn();
		const getCursor = vi.fn(() => ({ line: 3, ch: 0 }));
		const getValue = vi.fn(() => "Some note text here.");
		const editor = { replaceRange, setCursor, getCursor, getValue } as unknown as Editor;

		(suggest as any).context = {
			editor,
			start: { line: 3, ch: 5 },
			end: { line: 3, ch: 12 },
			query: "hello",
			file: { path: "test.md" } as unknown as TFile,
		};

		suggest.selectSuggestion("hello", {} as MouseEvent);

		expect(replaceRange).toHaveBeenCalledOnce();
		expect(replaceRange).toHaveBeenCalledWith(
			"> [!claude] hello\n\n",
			{ line: 3, ch: 5 },
			{ line: 3, ch: 12 }
		);
		expect(setCursor).toHaveBeenCalledWith({ line: 5, ch: 0 });
	});

	it("includes the user's question in the message passed to piClient.prompt (#10 regression)", () => {
		const app = new App();
		// Fake pi client — the prompt call's message is what #10 was missing.
		const piClient = {
			prompt: vi.fn().mockResolvedValue("prompt-1"),
			abort: vi.fn().mockResolvedValue(undefined),
		};
		const abortWatcher = { registerPendingCallout: vi.fn() };
		const plugin = {
			app,
			settings: { ...DEFAULT_SETTINGS },
			getPiClient: () => piClient,
			getAbortWatcher: () => abortWatcher,
		};
		const suggest = new InlinePiSuggest(plugin as any);

		const replaceRange = vi.fn();
		const setCursor = vi.fn();
		const getCursor = vi.fn(() => ({ line: 3, ch: 0 }));
		const getLine = vi.fn(() => ";; weather report for Berlin");
		const getValue = vi.fn(() => "Some note text here.");
		const editor = {
			replaceRange,
			setCursor,
			getCursor,
			getLine,
			getValue,
		} as unknown as Editor;

		(suggest as any).context = {
			editor,
			start: { line: 3, ch: 5 },
			end: { line: 3, ch: 34 },
			query: "weather report for Berlin",
			file: { path: "test.md" } as unknown as TFile,
		};

		suggest.selectSuggestion("weather report for Berlin", {} as MouseEvent);

		// The callout is inserted and the prompt is enqueued...
		expect(replaceRange).toHaveBeenCalled();
		expect(piClient.prompt).toHaveBeenCalledOnce();
		// ...and the payload actually contains the user's question —
		// this is the assertion that would have caught #10.
		const message = (piClient.prompt as any).mock.calls[0][0];
		expect(message).toContain("weather report for Berlin");
		expect(message).toContain("## Question");
	});
});
