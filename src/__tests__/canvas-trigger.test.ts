import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	findCanvasTrigger,
	InlinePiCanvasSuggest,
	prepareCanvasCallout,
} from "../canvas-trigger";
import { deliverCanvasReply } from "../canvas";
import { buildErrorCallout, buildResponseCallout } from "../callout";
import { Editor, Notice } from "obsidian";

// #19: the settle path must go through the canvas write path, not the
// trigger-time editor handle. Mock only `deliverCanvasReply` — the detection
// helpers stay real so the trigger-side fixtures below keep exercising them.
vi.mock("../canvas", async (importOriginal) => {
	const original = await importOriginal<typeof import("../canvas")>();
	return { ...original, deliverCanvasReply: vi.fn() };
});

const deliverMock = vi.mocked(deliverCanvasReply);

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

	it("includes the user's question in the message passed to piClient.prompt (#10 regression, canvas path)", () => {
		// Mirror of the markdown-path #10 regression in suggest.test.ts — the
		// canvas trigger had the same bug (query reached the callout, not pi).
		const editor = {
			// cursor at end of the 28-char line so findCanvasTrigger captures
			// the full query (ch is one past the last char, not on it).
			getCursor: vi.fn(() => ({ line: 0, ch: 28 })),
			getLine: vi.fn(() => ";; weather report for Berlin"),
			getValue: vi.fn(() => "Some note text here."),
			replaceRange: vi.fn(),
			setCursor: vi.fn(),
		} as unknown as Editor;

		const nodes = new Map<string, any>();
		nodes.set("node-1", { id: "node-1", child: { editor } });

		const piClient = {
			prompt: vi.fn().mockResolvedValue("prompt-1"),
			abort: vi.fn().mockResolvedValue(undefined),
		};

		const plugin = {
			app: {
				workspace: {
					getLeavesOfType: vi.fn((type: string) =>
						type === "canvas"
							? [{ view: { canvas: { nodes }, file: { path: "test.canvas" } } }]
							: [],
					),
				},
				commands: {
					commands: { "editor:save-file": true },
					executeCommandById: vi.fn(),
				},
			},
			settings: { triggerPhrase: ";;" },
			getPiClient: vi.fn(() => piClient),
		} as any;

		const result = prepareCanvasCallout(plugin, "test.canvas", editor);

		expect(result).not.toBeNull();
		expect(piClient.prompt).toHaveBeenCalledOnce();
		const message = (piClient.prompt as any).mock.calls[0][0];
		// #10: the question actually reaches pi (canvas path).
		expect(message).toContain("weather report for Berlin");
		expect(message).toContain("## Question");
		// Canvas path appends the node id to the payload.
		expect(message).toContain("Node ID: node-1");
	});
});
	describe("InlinePiCanvasSuggest (#18 — canvas contexts carry no TFile)", () => {
		const QUERY = "weather report for Berlin";

		/**
		 * Build the broken-but-real shape Obsidian hands to canvas node editors:
		 * `ctx.file` is null. The editor must be resolvable through the canvas leaf
		 * for the canvas suggest to work at all.
		 */
		function makeCanvasEditorMock() {
			return {
				getCursor: vi.fn(() => ({ line: 0, ch: 28 })),
				getLine: vi.fn(() => `;; ${QUERY}`),
				getValue: vi.fn(() => "Some canvas node text."),
				replaceRange: vi.fn(),
				setCursor: vi.fn(),
			} as unknown as Editor;
		}

		function makeCanvasLeaf(filePath: string, editor: Editor) {
			const nodes = new Map<string, any>();
			nodes.set("node-1", { id: "node-1", child: { editor } });
			return {
				view: {
					canvas: { nodes, requestSave: vi.fn() },
					file: { path: filePath },
				},
			};
		}

		function makePlugin(leaves: any[], piClient: any) {
			return {
				app: {
					workspace: {
						getLeavesOfType: vi.fn((type: string) =>
							type === "canvas" ? leaves : [],
						),
					},
					commands: {
						commands: { "editor:save-file": true },
						executeCommandById: vi.fn(),
					},
				},
				settings: { triggerPhrase: ";;" },
				getPiClient: vi.fn(() => piClient),
			} as any;
		}

		it("selectSuggestion proceeds via the derived .canvas path when ctx.file is null", () => {
			const editor = makeCanvasEditorMock();
			const piClient = {
				prompt: vi.fn().mockResolvedValue("prompt-1"),
				abort: vi.fn().mockResolvedValue(undefined),
			};
			const plugin = makePlugin([makeCanvasLeaf("board.canvas", editor)], piClient);
			const suggest = new InlinePiCanvasSuggest(plugin);

			(suggest as any).context = {
				editor,
				start: { line: 0, ch: 0 },
				end: { line: 0, ch: 28 },
				query: QUERY,
				// The shape that dead-ended the canvas path: no file.
				file: null,
			};

			suggest.selectSuggestion(QUERY, {} as MouseEvent);

			// Boundary assertion: the call reached pi with the derived path.
			expect(piClient.prompt).toHaveBeenCalledOnce();
			const message = (piClient.prompt as any).mock.calls[0][0];
			expect(message).toContain(QUERY);
			expect(message).toContain("## Question");
			expect(message).toContain("board.canvas");
			expect(message).toContain("Node ID: node-1");
			// The pending callout was inserted into the node editor.
			expect((editor.replaceRange as any)).toHaveBeenCalled();
		});

		it("selectSuggestion warns and no-ops when no canvas leaf matches the editor", () => {
			const editor = makeCanvasEditorMock();
			const piClient = {
				prompt: vi.fn().mockResolvedValue("prompt-1"),
				abort: vi.fn().mockResolvedValue(undefined),
			};
			// Canvas leaf exists but owns a different editor.
			const plugin = makePlugin(
				[makeCanvasLeaf("board.canvas", makeCanvasEditorMock())],
				piClient,
			);
			const suggest = new InlinePiCanvasSuggest(plugin);
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

			(suggest as any).context = {
				editor,
				start: { line: 0, ch: 0 },
				end: { line: 0, ch: 28 },
				query: QUERY,
				file: null,
			};

			expect(() => suggest.selectSuggestion(QUERY, {} as MouseEvent)).not.toThrow();
			expect(piClient.prompt).not.toHaveBeenCalled();
			expect((editor.replaceRange as any)).not.toHaveBeenCalled();
			expect(
				warnSpy.mock.calls.some((args) =>
					String(args[0]).includes("could not resolve the .canvas file"),
				),
			).toBe(true);

			warnSpy.mockRestore();
		});

		it("onTrigger triggers on a canvas node editor with a null file", () => {
			const editor = makeCanvasEditorMock();
			const plugin = makePlugin([makeCanvasLeaf("board.canvas", editor)], null);
			const suggest = new InlinePiCanvasSuggest(plugin);

			const info = suggest.onTrigger({ line: 0, ch: 28 }, editor, null);
			expect(info).not.toBeNull();
			expect(info?.start).toEqual({ line: 0, ch: 0 });
			expect(info?.query).toBe(` ${QUERY}`);
		});

		it("onTrigger does not trigger for a markdown editor", () => {
			const canvasEditor = makeCanvasEditorMock();
			const plugin = makePlugin([makeCanvasLeaf("board.canvas", canvasEditor)], null);
			const suggest = new InlinePiCanvasSuggest(plugin);

			const markdownEditor = makeCanvasEditorMock(); // same lines, not in a canvas
			expect(suggest.onTrigger({ line: 0, ch: 28 }, markdownEditor, null)).toBeNull();
		});
	});

describe("prepareCanvasCallout settle routing (#19)", () => {
	// Query keeps the leading space that findCanvasTrigger yields (it slices
	// the text after `;;`) — same string the pending callout was titled with.
	const QUERY = " weather report for Berlin";

	function makeSettleFixture() {
		const editor = {
			getCursor: vi.fn(() => ({ line: 0, ch: 28 })),
			getLine: vi.fn(() => ";; weather report for Berlin"),
			getValue: vi.fn(() => "Some canvas node text."),
			replaceRange: vi.fn(),
			setCursor: vi.fn(),
		} as unknown as Editor;

		const nodes = new Map<string, any>();
		nodes.set("node-1", { id: "node-1", child: { editor } });

		const piClient = {
			prompt: vi.fn().mockResolvedValue("prompt-1"),
			abort: vi.fn().mockResolvedValue(undefined),
		};

		const plugin = {
			app: {
				workspace: {
					getLeavesOfType: vi.fn((type: string) =>
						type === "canvas"
							? [{ view: { canvas: { nodes }, file: { path: "test.canvas" } } }]
							: [],
					),
				},
				commands: {
					commands: { "editor:save-file": true },
					executeCommandById: vi.fn(),
				},
			},
			settings: { triggerPhrase: ";;" },
			getPiClient: vi.fn(() => piClient),
		} as any;

		const prepared = prepareCanvasCallout(plugin, "test.canvas", editor);
		const handlers = (piClient.prompt as any).mock.calls[0][1];
		return { editor, plugin, piClient, prepared, onSettle: handlers.onSettle };
	}

	/** Let the deliverCanvasReply promise chain settle. */
	function flush(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, 0));
	}

	beforeEach(() => {
		Notice.reset();
		deliverMock.mockReset();
		deliverMock.mockResolvedValue({ ok: true });
	});

	it("green settle delivers a response callout through deliverCanvasReply", async () => {
		const { editor, plugin, prepared, onSettle } = makeSettleFixture();
		expect(prepared?.nodeId).toBe("node-1");

		onSettle({
			finalContent: "Sunny, 21°C.",
			aborted: false,
			error: false,
			stopReason: "stop",
		});
		await flush();

		expect(deliverMock).toHaveBeenCalledOnce();
		expect(deliverMock).toHaveBeenCalledWith(
			plugin.app,
			"test.canvas",
			"node-1",
			QUERY,
			buildResponseCallout(QUERY, "Sunny, 21°C."),
		);

		// The dead-editor path must not be touched: only the initial pending
		// callout insert wrote to the editor.
		expect((editor.replaceRange as any)).toHaveBeenCalledOnce();
		// And a successful delivery is quiet.
		expect(Notice.instances).toHaveLength(0);
	});

	it("error settle delivers an error callout with pi's message", async () => {
		const { plugin, onSettle } = makeSettleFixture();

		onSettle({
			finalContent: "",
			aborted: false,
			error: true,
			errorMessage: "Provider error",
			stopReason: "error",
		});
		await flush();

		expect(deliverMock).toHaveBeenCalledOnce();
		expect(deliverMock).toHaveBeenCalledWith(
			plugin.app,
			"test.canvas",
			"node-1",
			QUERY,
			buildErrorCallout(QUERY, "Provider error"),
		);
	});

	it("falls back to a generic error when pi reports no message", async () => {
		const { onSettle } = makeSettleFixture();

		onSettle({ finalContent: "", aborted: false, error: true, stopReason: "error" });
		await flush();

		const response = deliverMock.mock.calls[0][4];
		expect(response).toBe(buildErrorCallout(QUERY, "pi reported an error"));
	});

	it("aborted settle delivers the Aborted error callout", async () => {
		const { onSettle } = makeSettleFixture();

		onSettle({
			finalContent: "Partial answer",
			aborted: true,
			error: false,
			stopReason: "stop",
		});
		await flush();

		expect(deliverMock).toHaveBeenCalledOnce();
		expect(deliverMock.mock.calls[0][4]).toBe(buildErrorCallout(QUERY, "Aborted"));
	});

	it("warns and notifies when delivery reports failure (no silent evaporation)", async () => {
		const { onSettle } = makeSettleFixture();
		deliverMock.mockResolvedValue({ ok: false, reason: "no-match" });
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		onSettle({ finalContent: "answer", aborted: false, error: false, stopReason: "stop" });
		await flush();

		expect(warnSpy).toHaveBeenCalledOnce();
		expect(String(warnSpy.mock.calls[0][0])).toContain("canvas reply delivery failed");
		expect(String(warnSpy.mock.calls[0][0])).toContain("no-match");
		expect(Notice.instances.map((n) => n.message)).toContain(
			"Inline Pi: couldn't place the answer in the canvas node",
		);

		warnSpy.mockRestore();
	});

	it("warns and notifies when delivery throws", async () => {
		const { onSettle } = makeSettleFixture();
		deliverMock.mockRejectedValue(new Error("canvas exploded"));
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		onSettle({ finalContent: "answer", aborted: false, error: false, stopReason: "stop" });
		await flush();

		expect(warnSpy).toHaveBeenCalledOnce();
		expect(String(warnSpy.mock.calls[0][0])).toContain("canvas reply delivery threw");
		expect(Notice.instances.map((n) => n.message)).toContain(
			"Inline Pi: couldn't place the answer in the canvas node",
		);

		warnSpy.mockRestore();
	});
});
