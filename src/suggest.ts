import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type { InlinePiPluginLike } from "./types";
import {
	insertPendingCallout,
	type CalloutHandle,
} from "./callout-streaming";
import { buildPromptInstructions } from "./instructions";
import { buildCalloutHeader } from "./callout";

/**
 * Pure function for trigger detection — exported for unit testing.
 * Scans the text before the cursor for the last occurrence of triggerPhrase.
 * Returns the trigger index and the query text after the trigger, or null.
 */
export function findTrigger(
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

export class InlinePiSuggest extends EditorSuggest<string> {
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
		const lineText = editor.getLine(cursor.line);
		const result = findTrigger(
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
		el.setText("Ask pi: " + value);
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

		// Get required services (optional for basic testing)
		const piClient = (this.plugin as any).getPiClient?.();
		const abortWatcher = (this.plugin as any).getAbortWatcher?.();

		// If services aren't available, just insert the callout header (for unit tests)
		if (!piClient || !abortWatcher) {
			const calloutHeader = buildCalloutHeader(value);
			editor.replaceRange(calloutHeader + "\n\n", start, end);
			editor.setCursor({ line: start.line + 2, ch: 0 });
			return;
		}

		// 1. Insert the pending callout using Worker A's streaming callout API
		const handle = insertPendingCallout(editor, file, value);
		const promptId = handle.id;

		// 2. Wire the settle and abort callbacks to route events to pi-client
		// wireSettle/wireAbort are added to the handle by insertPendingCallout
		const typedHandle = handle as any;
		typedHandle.wireSettle((result: any) => {
			// Route to pi-client's settle handler via the plugin's hook system
			// The actual routing is handled in main.ts via onPiSettle callback
		});

		typedHandle.wireAbort(() => {
			void piClient.abort().catch(() => {
				console.warn(`Inline Pi: abort failed for ${promptId}`);
			});
		});

		// 3. Register the callout with abort-watcher for header-presence monitoring
		abortWatcher.registerPendingCallout(
			promptId,
			file.path,
			value,
			start.line
		);

		// 4. Build the prompt payload using Worker A's buildPromptInstructions.
		// #10: include the note text at trigger time so the model doesn't have
		// to read the file (and so prior callouts can be stripped before they
		// reach the model).
		const cursorLine = editor.getCursor().line;
		const noteText = editor.getValue();
		// #10: pass the user's question so the payload actually contains it.
		const payload = buildPromptInstructions(file.path, cursorLine, noteText, value);

		// 5. Enqueue the prompt with pi-client. T42: no onDelta — the callout holds
		// its pending header until settle; live activity goes to the status bar via
		// the plugin-level onActivity callback wired in main.ts.
		piClient.prompt(payload, {
			onSettle: (result: any) => handle.onSettle(result),
		})
			.then((id: string) => {
				console.log(`Inline Pi: prompt ${id} accepted by pi`);
			})
			.catch((err: Error) => {
				console.error(`Inline Pi: prompt failed: ${err.message}`);
			});
	}
}
