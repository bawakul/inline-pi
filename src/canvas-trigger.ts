import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type { InlinePiPluginLike } from "./types";
import type { CalloutHandle } from "./callout-streaming";
import { insertPendingCallout } from "./callout-streaming";
import { buildPromptInstructions } from "./instructions";
import { buildCalloutHeader } from "./callout";
import {
	deliverCanvasReply,
	findCanvasNodeIdForEditor,
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

	// Wire settle and abort callbacks
	const typedHandle = handle as any;
	typedHandle.wireSettle((result: any) => {
		// Route settle to plugin's hook system via the event hooks
		const hooks = (plugin as any).hooks;
		if (hooks?.onSettle) {
			hooks.onSettle({ path: filePath } as TFile, cursor, result);
		}
	});

	typedHandle.wireAbort(() => {
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

	// Build the prompt payload with node id and file path
	const payload = buildPromptInstructions(filePath, cursor.line);
	// Add node id to the message (appended to instructions)
	const messageWithNodeId = `${payload}\nNode ID: ${nodeId}`;

	// Enqueue the prompt with pi-client
	void piClient.prompt(messageWithNodeId)
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

	/**
	 * Check if the current editor is a canvas node editor by probing the workspace
	 * for canvas leaves and checking if any node's editor matches the current editor.
	 */
	private isCanvasNodeEditor(editor: Editor): boolean {
		const leaves = this.plugin.app.workspace.getLeavesOfType("canvas");
		for (const leaf of leaves) {
			const view = leaf.view as any;
			if (!view?.canvas) continue;
			for (const node of view.canvas.nodes.values()) {
				if (node.child?.editor === editor) {
					return true;
				}
			}
		}
		return false;
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_file: TFile | null
	): EditorSuggestTriggerInfo | null {
		// Only trigger if the editor is a canvas node editor
		if (!this.isCanvasNodeEditor(editor)) {
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
		const { editor, start, end, file } = ctx;

		if (!file) {
			console.warn("Inline Pi: selectSuggestion called without a file");
			return;
		}

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
		const result = prepareCanvasCallout(this.plugin, file.path, editor);
		if (!result || !result.handle) {
			console.warn("Inline Pi: failed to prepare canvas callout");
		}
	}
}
