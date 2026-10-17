import {
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	TFile,
} from "obsidian";
import type { InlinePiPluginLike } from "./types";
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

/**
 * Build the per-prompt instruction payload.
 * 
 * The payload includes:
 * - INSTRUCTIONS_PREFIX (from Worker A's callout-streaming.ts)
 * - Note absolute path
 * - Cursor line number
 * - Core instructions (match the tone, no follow-up questions, etc.)
 * 
 * Worker A's buildPromptInstructions export provides the complete implementation.
 * This is a placeholder until the export is available.
 */
function buildPromptInstructions(
	query: string,
	notePath: string,
	cursorLine: number
): string {
	// In M1, the instruction builder will come from Worker A's callout-streaming.ts
	// For now, we construct a minimal payload.
	// The real implementation will include: INSTRUCTIONS_PREFIX + note path + cursor line + core instructions.
	return query;
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

		// 1. Insert the pending callout (Worker A's insertPendingCallout)
		// For now, we use the old buildCalloutHeader approach since insertPendingCallout
		// depends on callout-streaming.ts exports that Worker A will commit.
		const calloutHeader = buildCalloutHeader(value);
		editor.replaceRange(calloutHeader + "\n\n", start, end);
		
		// Place cursor on the blank line below the callout
		editor.setCursor({ line: start.line + 2, ch: 0 });

		// 2. Save the file BEFORE sending prompt (load-bearing for pi-client reads)
		// Command ID verified against Obsidian 1.1.0+ source and mock
		// The plugin's app.commands.executeCommandById should be available
		// We check if the command exists before executing
		const saveCommandId = "editor:save-file";
		const app = this.plugin.app as any;
		if (app.commands?.commands[saveCommandId]) {
			void app.commands.executeCommandById(saveCommandId);
		} else {
			// Fallback: try alternative save command IDs
			const alternativeCommands = [
				"editor:save-file",
				"file:save",
				"workspace:save",
			];
			for (const cmdId of alternativeCommands) {
				if (app.commands?.commands[cmdId]) {
					void app.commands.executeCommandById(cmdId);
					console.log(`Inline Pi: using alternative save command: ${cmdId}`);
					break;
				}
			}
		}

		// 3. Build the prompt payload
		const cursorLine = editor.getCursor().line;
		const notePath = file.path;
		const payload = buildPromptInstructions(value, notePath, cursorLine);

		// 4. Call piClient.prompt() and register the callout handle
		const piClient = (this.plugin as any).getPiClient?.();
		const abortWatcher = (this.plugin as any).getAbortWatcher?.();
		
		if (piClient) {
			const promptId = `callout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
			
			// TODO: Once Worker A commits callout-streaming.ts with insertPendingCallout,
			// replace the above with:
			//   import { insertPendingCallout } from "./callout-streaming";
			//   const handle = insertPendingCallout(editor, file, value);
			//   handle.wireSettle(...);
			//   handle.wireAbort(...);
			
			// For now, we just enqueue the prompt without streaming state machine
			piClient.prompt(payload)
				.then((id: string) => {
					console.log(`Inline Pi: prompt ${id} accepted by pi`);
					// Prompt has been accepted (started or handled disposition)
					// The streaming events will arrive via onDelta/onSettle callbacks
				})
				.catch((err: Error) => {
					console.error(`Inline Pi: prompt failed: ${err.message}`);
				});
		} else {
			console.error("Inline Pi: piClient not available for prompt");
		}
	}
}
