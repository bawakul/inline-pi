import { describe, it, expect, vi } from "vitest";
import { findTrigger, InlinePiSuggest } from "../suggest";
import { App, Editor, TFile } from "obsidian";
import { DEFAULT_SETTINGS } from "../settings";

/**
 * Build an app whose open canvas leaves hold exactly `editor` as a node editor.
 * Used to reproduce the #18 shape where Obsidian hands the suggest a canvas
 * node editor with `file: null`.
 */
function appWithCanvasNode(editor: Editor): App {
	const app = new App();
	app.workspace.getLeavesOfType = vi.fn((type: string) =>
		type === "canvas"
			? [
				{
					view: {
						canvas: {
							nodes: new Map([["node-1", { id: "node-1", child: { editor } }]]),
							requestSave: vi.fn(),
						},
						file: { path: "board.canvas" },
					},
				} as any,
			]
			: [],
	);
	return app;
}

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

describe("InlinePiSuggest onTrigger (#18 — canvas guard)", () => {
	it("returns null for a canvas node editor so the canvas suggest owns the keystroke", () => {
		const line = ";; weather report";
		const canvasEditor = {
			getLine: vi.fn(() => line),
			getCursor: vi.fn(() => ({ line: 0, ch: line.length })),
		} as unknown as Editor;
		const app = appWithCanvasNode(canvasEditor);
		const plugin = { app, settings: { ...DEFAULT_SETTINGS } };
		const suggest = new InlinePiSuggest(plugin as any);

		// file is null on canvas — the markdown suggest must decline, not dead-end.
		expect(suggest.onTrigger({ line: 0, ch: line.length }, canvasEditor, null)).toBeNull();
	});

	it("still triggers for a markdown editor while a canvas is open", () => {
		const canvasEditor = { getLine: vi.fn(() => "canvas text") } as unknown as Editor;
		const app = appWithCanvasNode(canvasEditor);
		const plugin = { app, settings: { ...DEFAULT_SETTINGS } };
		const suggest = new InlinePiSuggest(plugin as any);

		// ch is one past the last char — the cursor sits after "report".
		const line = ";; weather report";
		const markdownEditor = { getLine: vi.fn(() => line) } as unknown as Editor;
		const info = suggest.onTrigger({ line: 0, ch: line.length }, markdownEditor, {
			path: "note.md",
		} as unknown as TFile);

		expect(info).not.toBeNull();
		expect(info?.start).toEqual({ line: 0, ch: 0 });
		expect(info?.query).toBe(" weather report");
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

	it("no-ops safely when the context has no file (#18 canvas dead-end guard)", () => {
		const app = new App();
		const piClient = { prompt: vi.fn().mockResolvedValue("prompt-1") };
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
		const editor = {
			replaceRange,
			setCursor,
			getCursor: vi.fn(() => ({ line: 0, ch: 0 })),
			getLine: vi.fn(() => ";; hello"),
			getValue: vi.fn(() => ""),
		} as unknown as Editor;

		(suggest as any).context = {
			editor,
			start: { line: 0, ch: 0 },
			end: { line: 0, ch: 7 },
			query: "hello",
			// The broken shape: canvas node editor contexts have no TFile.
			file: null,
		};

		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(() => suggest.selectSuggestion("hello", {} as MouseEvent)).not.toThrow();

		// No callout mutation, no prompt, no abort-watcher registration.
		expect(replaceRange).not.toHaveBeenCalled();
		expect(setCursor).not.toHaveBeenCalled();
		expect(piClient.prompt).not.toHaveBeenCalled();
		expect(abortWatcher.registerPendingCallout).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalled();

		warnSpy.mockRestore();
	});

	it("drives the queued callout look from pi-client lifecycle callbacks (#29)", async () => {
		const lines = [";; queued question"];
		// Stateful replacement: header rewrites must land in the backing lines
		// or `findCalloutBlock` would keep seeing the original header.
		const editor = {
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
			lineCount: () => lines.length,
			getLine: (n: number) => lines[n] ?? "",
			setCursor: vi.fn(),
			getCursor: vi.fn(() => ({ line: 0, ch: 0 })),
			getValue: vi.fn(() => ""),
		} as unknown as Editor;

		// A prompt that hasn't been accepted yet — lets us observe the queued
		// state before onActive fires.
		let handlers: { onQueued?: () => void; onSettle?: (r: any) => void } = {};
		let resolvePrompt!: (id: string) => void;
		const promptPromise = new Promise<string>((res) => {
			resolvePrompt = res;
		});
		const piClient = {
			prompt: vi.fn((_msg: string, h: any) => {
				handlers = h;
				return promptPromise;
			}),
			abort: vi.fn().mockResolvedValue(undefined),
		};
		const abortWatcher = { registerPendingCallout: vi.fn() };
		const plugin = {
			app: new App(),
			settings: { ...DEFAULT_SETTINGS },
			getPiClient: () => piClient,
			getAbortWatcher: () => abortWatcher,
		};
		const suggest = new InlinePiSuggest(plugin as any);

		(suggest as any).context = {
			editor,
			start: { line: 0, ch: 0 },
			end: { line: 0, ch: 17 },
			query: "queued question",
			file: { path: "test.md" } as unknown as TFile,
		};

		suggest.selectSuggestion("queued question", {} as MouseEvent);

		expect(lines[0]).toBe("> [!claude] queued question");
		expect(handlers.onQueued).toBeTypeOf("function");

		// pi-client says the prompt is waiting behind a busy run.
		handlers.onQueued!();
		expect(lines[0]).toBe("> [!claude-queued] queued question");

		// pi accepts the run (disposition started/handled) → header flips back.
		resolvePrompt("prompt-1");
		await new Promise((r) => setTimeout(r, 0));
		expect(lines[0]).toBe("> [!claude] queued question");
	});
});
