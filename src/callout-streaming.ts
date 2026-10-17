import type { Editor, EditorPosition, TFile } from "obsidian";
import type { PiSettleResult } from "./pi-client";
import {
	buildCalloutHeader,
	replaceCalloutBlock,
	findCalloutBlock,
} from "./callout";

// --- Streaming state types ---

export type CalloutState = "pending" | "queued" | "streaming" | "green" | "error" | "aborted";

export interface CalloutHandle {
	/** Unique identifier for correlation with pi-client. */
	id: string;
	/** Feed a text delta to the callout. */
	onDelta(delta: string): void;
	/** Finalize with a settle result (aborted/error/green). */
	onSettle(result: PiSettleResult): void;
	/** Mark the callout as queued (before active). */
	onQueued(): void;
	/** Abort the underlying run (sends abort to pi-client). */
	abort(): void;
}

// --- Throttled delta accumulator ---

class DeltaAccumulator {
	private buffer = "";
	private timer: NodeJS.Timeout | null = null;
	private readonly throttleMs = 150;
	private callback: (text: string) => void;

	constructor(callback: (text: string) => void) {
		this.callback = callback;
	}

	private flush(): void {
		if (this.buffer.length === 0) return;
		this.callback(this.buffer);
		this.buffer = "";
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	public add(delta: string): void {
		if (this.timer) clearTimeout(this.timer);
		this.buffer += delta;
		// Throttle: flush after delay if no more deltas arrive
		this.timer = setTimeout(() => this.flush(), this.throttleMs);
	}

	public flushNow(): void {
		this.flush();
	}
}

// --- Callout instance class ---

class CalloutInstance {
	public readonly id: string;
	private readonly editor: Editor;
	private readonly file: TFile;
	private readonly query: string;
	private readonly startLine: number;
	private onSettleHandler: (result: PiSettleResult) => void = () => {};
	private abortHandler: () => void = () => {};
	private state: CalloutState = "pending";
	private deltaAccumulator: DeltaAccumulator | null = null;
	private pendingAbort = false;

	constructor(
		id: string,
		editor: Editor,
		file: TFile,
		query: string,
		startLine: number
	) {
		this.id = id;
		this.editor = editor;
		this.file = file;
		this.query = query;
		this.startLine = startLine;
	}

	/** Wire the settle callback. */
	public wireSettle(cb: (result: PiSettleResult) => void): void {
		this.onSettleHandler = cb;
	}

	/** Wire the abort callback. */
	public wireAbort(cb: () => void): void {
		this.abortHandler = cb;
	}

	public onQueued(): void {
		if (this.state !== "pending") return;
		this.state = "queued";
		// In queued state, keep the pending callout visible.
	}

	public onDelta(delta: string): void {
		if (this.state === "green" || this.state === "error" || this.state === "aborted") {
			return;
		}

		// Transition from pending/queued to streaming on first delta
		if (this.state === "pending" || this.state === "queued") {
			this.state = "streaming";
			// Create delta accumulator with throttled writes
			this.deltaAccumulator = new DeltaAccumulator((text) => {
				// Append text to the callout body (after the header line)
				this.appendBodyText(text);
			});
		}

		if (this.deltaAccumulator) {
			this.deltaAccumulator.add(delta);
		}
	}

	public onSettle(result: PiSettleResult): void {
		// Ensure any buffered deltas are flushed
		if (this.deltaAccumulator) {
			this.deltaAccumulator.flushNow();
			this.deltaAccumulator = null;
		}

		// Update state and content
		if (result.aborted) {
			this.state = "aborted";
			this.replaceWithCallout(buildErrorCallout(this.query, "Aborted"));
		} else if (result.error) {
			this.state = "error";
			const errorMsg = result.errorMessage || "pi reported an error";
			this.replaceWithCallout(buildErrorCallout(this.query, errorMsg));
		} else {
			this.state = "green";
			// Final content replace with the authoritative message_end content
			const body = result.finalContent ?? "";
			if (body === "") {
				// Empty response: header + "**Claude:** " on second line (collapsible)
				this.replaceWithCallout(`> [!claude-done]+ ${this.query}\n> **Claude:** `);
			} else {
				// Build proper response callout with final content
				const responseLines = body
					.split("\n")
					.map((line, i) => (i === 0 ? `> **Claude:** ${line}` : `> ${line}`))
					.join("\n");
				this.replaceWithCallout(`> [!claude-done]+ ${this.query}\n${responseLines}`);
			}
		}

		this.onSettleHandler(result);
	}

	private appendBodyText(text: string): void {
		const currentCallout = findCalloutBlock(this.editor, this.query, this.startLine);
		if (!currentCallout) return;

		// Read current content and append text to the last body line
		const lines: string[] = [];
		for (let i = currentCallout.from; i <= currentCallout.to; i++) {
			lines.push(this.editor.getLine(i));
		}

		// Find the last line that starts with "> " (body line)
		const bodyPrefix = "> ";
		let lastBodyLineIdx = -1;
		for (let i = lines.length - 1; i >= 0; i--) {
			if (lines[i].startsWith(bodyPrefix)) {
				lastBodyLineIdx = i;
				break;
			}
		}

		if (lastBodyLineIdx === -1) {
			// No body line found, add one
			lines.push(bodyPrefix + text);
		} else {
			// Append to the last body line
			lines[lastBodyLineIdx] = lines[lastBodyLineIdx] + text;
		}

		const newContent = lines.join("\n") + "\n";
		replaceCalloutBlock(this.editor, currentCallout.from, currentCallout.to, newContent);
	}

	private replaceWithCallout(newContent: string): void {
		const currentCallout = findCalloutBlock(this.editor, this.query, this.startLine);
		if (!currentCallout) return;
		// Replace the entire callout block with the final content
		replaceCalloutBlock(this.editor, currentCallout.from, currentCallout.to, newContent);
	}

	public abort(): void {
		if (this.pendingAbort) return;
		this.pendingAbort = true;

		// If streaming, flush any pending deltas first
		if (this.deltaAccumulator) {
			this.deltaAccumulator.flushNow();
			this.deltaAccumulator = null;
		}

		// Update UI to aborted state immediately
		this.state = "aborted";
		this.replaceWithCallout(buildErrorCallout(this.query, "Aborted"));

		// Trigger the abort callback (calls piClient.abort())
		this.abortHandler();
	}

	public getState(): CalloutState {
		return this.state;
	}
}

// --- Exported API ---

/**
 * Build an error callout with the original query as title and error in body.
 * The first line of the error message gets the > ⚠️ prefix;
 * subsequent lines (if any) are appended without prefix.
 */
export function buildErrorCallout(query: string, errorMsg: string): string {
	return `> [!claude] ${query}\n> ⚠️ ${errorMsg}`;
}

/**
 * Insert a pending callout and return a handle for streaming events.
 * The callout header is inserted; body will be populated via streaming deltas.
 * On settle, the body is replaced with the authoritative final content.
 *
 * The caller MUST call `handle.wireSettle()` and `handle.wireAbort()` after
 * construction to connect the callbacks from main.ts hooks.
 *
 * @param editor Obsidian editor
 * @param file The current TFile
 * @param query The user's prompt text (the callout title)
 * @returns A handle to drive the callout via onDelta/onSettle/abort
 */
export function insertPendingCallout(
	editor: Editor,
	file: TFile,
	query: string
): CalloutHandle {
	// Insert the pending callout header + blank line for cursor
	const cursor = editor.getCursor();
	const headerLine = buildCalloutHeader(query);
	const newLines = [headerLine, "", ""];
	const from = { line: cursor.line, ch: 0 };
	const to = { line: cursor.line, ch: editor.getLine(cursor.line).length };
	editor.replaceRange(newLines.join("\n"), from, to);

	// Position cursor on the blank line below the callout
	editor.setCursor({ line: cursor.line + 2, ch: 0 });

	// Store start position for findCalloutBlock reliability
	const startLine = cursor.line;

	// Generate a unique id for correlation with pi-client
	const id = `callout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	const instance = new CalloutInstance(
		id,
		editor,
		file,
		query,
		startLine
	);

	const handle: CalloutHandle = {
		id,
		onDelta: (delta) => instance.onDelta(delta),
		onSettle: (result) => instance.onSettle(result),
		onQueued: () => instance.onQueued(),
		abort: () => instance.abort(),
	};

	// Add wire methods to the handle (TypeScript will complain if used naively,
	// but runtime this works. The suggest layer knows the contract.)
	(handle as any).wireSettle = (cb: (result: PiSettleResult) => void) => {
		instance.wireSettle(cb);
	};
	(handle as any).wireAbort = (cb: () => void) => {
		instance.wireAbort(cb);
	};

	return handle;
}
