import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	Notice,
	TFile,
} from "obsidian";
import type { InlinePiPluginLike } from "./types";
import type { CalloutHandle } from "./callout-streaming";
import { insertPendingCallout } from "./callout-streaming";
import type { PiSettleResult } from "./pi-client";
import { buildPromptInstructions } from "./instructions";
import {
	buildCalloutHeader,
	buildErrorCallout,
	buildResponseCallout,
} from "./callout";
import {
	deliverCanvasReply,
	findCanvasLeafForEditor,
	findCanvasNodeIdForEditor,
	isCanvasNodeEditor,
} from "./canvas";

/**
 * Pure function for trigger detection in a canvas node.
 * Scans the text before the cursor for the last occurrence of triggerPhrase.
 * Returns the trigger index and the query text after the trigger, or null.
 */
export function findCanvasTrigger(
	lineText: string,
	cursorCh: number,
	triggerPhrase: string
): { triggerIndex: number; query: string } | null {
	const textBeforeCursor = lineText.substring(0, cursorCh);
	const triggerIndex = textBeforeCursor.lastIndexOf(triggerPhrase);
	if (triggerIndex === -1) {
		return null;
	}
	const query = textBeforeCursor.substring(
		triggerIndex + triggerPhrase.length
	);
	return { triggerIndex, query };
}

/**
 * Trigger-time node identification wrapper that inserts pending callout
 * and returns a handle for streaming.
 */
export function prepareCanvasCallout(
	plugin: InlinePiPluginLike,
	filePath: string,
	editor: Editor
): { handle: CalloutHandle | null; nodeId: string | null } | null {
	// Get piClient from plugin (type-asserted for canvas trigger)
	const piClient = (plugin as any).getPiClient?.();

	if (!piClient) {
		console.warn("Inline Pi: piClient not available for canvas trigger");
		return null;
	}

	// Find the canvas node for this editor
	const nodeId = findCanvasNodeIdForEditor(plugin.app, filePath, editor);
	if (!nodeId) {
		console.warn(`Inline Pi: could not find canvas node for editor in ${filePath}`);
		return null;
	}

	// Get the current line and find trigger
	const cursor = editor.getCursor();
	const lineText = editor.getLine(cursor.line);
	const triggerResult = findCanvasTrigger(
		lineText,
		cursor.ch,
		plugin.settings.triggerPhrase
	);

	if (!triggerResult) {
		return null;
	}

	const { triggerIndex, query } = triggerResult;

	// Insert pending callout (replaces the ;; trigger with a callout header)
	const handle = insertPendingCallout(editor, { path: filePath } as TFile, query);
	const promptId = handle.id;

	// Wire the abort callback. Abort does not depend on the editor surviving,
	// so the handle's abort path stays as-is (#19).
	(handle as any).wireAbort(() => {
		void piClient.abort().catch(() => {
			console.warn(`Inline Pi: abort failed for ${promptId}`);
		});
	});

	// Save the file BEFORE sending prompt (load-bearing for pi-client reads)
	const saveCommandId = "editor:save-file";
	const app = plugin.app as any;
	if (app.commands?.commands[saveCommandId]) {
		void app.commands.executeCommandById(saveCommandId);
	}

	// Build the prompt payload with node id and file path. #10: include the
	// node editor's text at trigger time (same Editor API as markdown).
	const noteText = editor.getValue();
	// #10: pass the user's question so the payload actually contains it.
	const payload = buildPromptInstructions(filePath, cursor.line, noteText, query);
	// Add node id to the message (appended to instructions)
	const messageWithNodeId = `${payload}\nNode ID: ${nodeId}`;

	/**
	 * #19: settle must NOT go through `handle.onSettle` on canvas.
	 *
	 * The handle was built around the node's CodeMirror editor captured at
	 * trigger time. A canvas node's editor is created on focus and destroyed on
	 * blur; by the time pi settles the editor is detached, so the handle's
	 * `findCalloutBlock` misses and the reply evaporates silently. Canvas has a
	 * purpose-built write path — `deliverCanvasReply` (node-ID-first `setData`
	 * for an open leaf, atomic JSON patch for a closed one) — which works
	 * whether or not the editor survived. Build the final callout text here and
	 * hand it to that path instead.
	 */
	const deliverSettle = (result: PiSettleResult): void => {
		const response = result.aborted
			? buildErrorCallout(query, "Aborted")
			: result.error
				? buildErrorCallout(query, result.errorMessage || "pi reported an error")
				: buildResponseCallout(query, result.finalContent ?? "");

		void deliverCanvasReply(app, filePath, nodeId, query, response)
			.then((outcome) => {
				if (outcome.ok) return;
				// Never evaporate: a failed delivery has to be visible to the user.
				console.warn(
					`Inline Pi: canvas reply delivery failed for ${filePath} (node ${nodeId}): ${outcome.reason}`,
					outcome.error,
				);
				new Notice("Inline Pi: couldn't place the answer in the canvas node");
			})
			.catch((err: unknown) => {
				console.warn(
					`Inline Pi: canvas reply delivery threw for ${filePath} (node ${nodeId})`,
					err,
				);
				new Notice("Inline Pi: couldn't place the answer in the canvas node");
			});
	};

	// Enqueue the prompt with pi-client. T42: no onDelta — the callout holds its
	// pending header until settle; live activity goes to the status bar via the
	// plugin-level onActivity callback wired in main.ts.
	void piClient.prompt(messageWithNodeId, {
		onSettle: deliverSettle,
	})
		.then((id: string) => {
			console.log(`Inline Pi: canvas prompt ${id} accepted by pi`);
		})
		.catch((err: Error) => {
			console.error(`Inline Pi: canvas prompt failed: ${err.message}`);
		});

	return { handle, nodeId };
}

/**
 * Canvas-specific trigger for P5.
 * This suggest only triggers when the active editor is a canvas node editor.
 * Uses the same ;; trigger as markdown nodes.
 */
export class InlinePiCanvasSuggest extends EditorSuggest<string> {
	plugin: InlinePiPluginLike;

	constructor(plugin: InlinePiPluginLike) {
		super(plugin.app);
		this.plugin = plugin;
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		// Only trigger if the editor is a canvas node editor (shared detector,
		// #18 — the same one the markdown suggest uses to stand down).
		if (!isCanvasNodeEditor(this.plugin.app, editor)) {
			return null;
		}

		// Check if the trigger phrase is present in the line
		const lineText = editor.getLine(cursor.line);
		const result = findCanvasTrigger(
			lineText,
			cursor.ch,
			this.plugin.settings.triggerPhrase
		);
		if (result === null) {
			return null;
		}
		return {
			start: { line: cursor.line, ch: result.triggerIndex },
			end: cursor,
			query: result.query,
		};
	}

	getSuggestions(
		context: EditorSuggestContext
	): string[] | Promise<string[]> {
		if (context.query.trim() === "") {
			return [];
		}
		return [context.query];
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText("Ask pi (canvas): " + value);
	}

	selectSuggestion(
		value: string,
		_evt: MouseEvent | KeyboardEvent
	): void {
		const ctx = this.context;
		if (!ctx) {
			return;
		}
		const { editor, start, end } = ctx;

		// #18: Obsidian passes no TFile for canvas node editors, so derive the
		// owning `.canvas` path from the leaf that holds this editor.
		const location = findCanvasLeafForEditor(this.plugin.app, editor);
		if (!location || !location.filePath) {
			console.warn(
				"Inline Pi: canvas selectSuggestion could not resolve the .canvas file for this editor",
			);
			return;
		}
		const filePath = location.filePath;

		// Get required services from plugin
		const piClient = (this.plugin as any).getPiClient?.();

		// If piClient isn't available, just insert the callout header (for unit tests)
		if (!piClient) {
			const calloutHeader = buildCalloutHeader(value);
			editor.replaceRange(calloutHeader + "\n\n", start, end);
			editor.setCursor({ line: start.line + 2, ch: 0 });
			return;
		}

		// Use the same prepareCanvasCallout logic as the trigger
		const result = prepareCanvasCallout(this.plugin, filePath, editor);
		if (!result || !result.handle) {
			console.warn("Inline Pi: failed to prepare canvas callout");
		}
	}
}
