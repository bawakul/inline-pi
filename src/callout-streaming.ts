import type { Editor, TFile } from "obsidian";
import type { PiSettleResult } from "./pi-client";
import {
	buildCalloutHeader,
	replaceCalloutBlock,
	findCalloutBlock,
} from "./callout";

// --- Callout state types ---

/**
 * Callout lifecycle states.
 *
 * T42 (2026-10-25): the callout no longer streams token-by-token. It holds a
 * static pending header (`> [!claude] {query}`) until the run settles, then is
 * replaced in one shot with the final content. Live activity (thinking, tool
 * calls, byte count) is shown in the status bar instead — see main.ts
 * `onActivity`. The `streaming` state is gone; `onDelta` is a no-op kept on the
 * handle only so the suggest/canvas layers don't have to know about the change.
 */
export type CalloutState = "pending" | "queued" | "green" | "error" | "aborted";

export interface CalloutHandle {
	/** Unique identifier for correlation with pi-client. */
	id: string;
	/**
	 * No-op since T42. The callout no longer streams; the final content is
	 * rendered on `onSettle`. Kept on the handle so callers don't have to
	 * branch on a streaming-vs-not contract.
	 */
	onDelta(delta: string): void;
	/** Finalize with a settle result (aborted/error/green). */
	onSettle(result: PiSettleResult): void;
	/** Mark the callout as queued (before active). */
	onQueued(): void;
	/** Abort the underlying run (sends abort to pi-client). */
	abort(): void;
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

	/**
	 * No-op since T42. The callout holds its pending header until settle; the
	 * status bar (main.ts `onActivity`) shows live progress instead. Deltas are
	 * still consumed by pi-client for byte-count telemetry.
	 */
	public onDelta(_delta: string): void {
		// Intentionally empty — see T42 re-scope notes.
	}

	public onSettle(result: PiSettleResult): void {
		// Update state and content. The whole callout is replaced in one shot
		// with the authoritative message_end content — no buffered streaming
		// to flush.
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

	private replaceWithCallout(newContent: string): void {
		const currentCallout = findCalloutBlock(this.editor, this.query, this.startLine);
		if (!currentCallout) return;
		// Replace the entire callout block with the final content
		replaceCalloutBlock(this.editor, currentCallout.from, currentCallout.to, newContent);
	}

	public abort(): void {
		if (this.pendingAbort) return;
		this.pendingAbort = true;

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
 * Insert a pending callout and return a handle for settle/abort events.
 *
 * The callout header is inserted and held as a static "working" placeholder
 * (T42). The body is NOT populated by streaming deltas; instead, the final
 * answer is rendered in one shot when the run settles via `onSettle`. Live
 * progress (thinking / tool calls / byte count) is shown in the status bar
 * by main.ts via the pi-client `onActivity` callback.
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
