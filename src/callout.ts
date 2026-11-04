import type { Editor, EditorPosition } from "obsidian";

/**
 * Build a single-line callout header with the user's prompt as the title.
 * The prompt IS the title — no body lines are generated.
 */
export function buildCalloutHeader(query: string): string {
	return `> [!claude] ${query}`;
}

/**
 * Build the header for a callout whose prompt is waiting in pi-client's queue.
 * Same title as the pending header — only the callout type differs, so the
 * queued look can be styled independently (#29). The header is rewritten back
 * to `buildCalloutHeader(query)` once pi actually starts the run.
 */
export function buildQueuedCalloutHeader(query: string): string {
	return `> [!claude-queued] ${query}`;
}

/**
 * Replace a range in the editor with a callout header.
 */
export function insertCallout(
	editor: Editor,
	from: EditorPosition,
	to: EditorPosition,
	content: string
): void {
	editor.replaceRange(buildCalloutHeader(content), from, to);
}

/**
 * Build a response callout with the original query and pi's response.
 * The `+` makes it collapsible in Obsidian.
 */
export function buildResponseCallout(query: string, response: string): string {
	const header = `> [!claude-done]+ ${query}`;
	if (response === "") {
		return `${header}\n> **Pi:** `;
	}
	const responseLines = response
		.split("\n")
		.map((line, i) => i === 0 ? `> **Pi:** ${line}` : `> ${line}`)
		.join("\n");
	return `${header}\n${responseLines}`;
}

/**
 * Build an error callout with the original query as title and error in body.
 */
export function buildErrorCallout(query: string, errorMsg: string): string {
	return `> [!claude] ${query}\n> ⚠️ ${errorMsg}`;
}

/**
 * Find a callout block by matching a header line in the document.
 * Scans the entire document for a line starting with `marker` (a single
 * prefix, or a list of accepted prefixes — e.g. the pending and queued
 * `[!claude]` variants). This is robust against line drift caused by edits
 * above the callout.
 *
 * Falls back to proximity search (±10 lines from nearLine) if query is
 * not provided, for backward compatibility.
 *
 * Returns inclusive {from, to} line numbers, or null if not found.
 */
export function findCalloutRange(
	editor: Editor,
	nearLine: number,
	marker: string | string[] = "> [!claude] "
): { from: number; to: number } | null {
	const lineCount = editor.lineCount();
	const markers = Array.isArray(marker) ? marker : [marker];

	// A full-header marker (built from a query, no trailing space — e.g.
	// `> [!claude] fix`) must match the line EXACTLY: startsWith would alias a
	// longer query with it as a prefix ("fix" vs "fix typo", #36 review finding 2).
	// A prefix marker (trailing space) keeps startsWith semantics.
	const isMatch = (line: string, m: string): boolean =>
		m.endsWith(" ") ? line.startsWith(m) : line === m;

	// Collect ALL matching lines, then prefer the one closest to nearLine
	// (#36 review finding 1: first-match-wins rewrites the WRONG callout when
	// the same query is asked twice — one active, one queued — inverting their
	// looks mid-run). Ties go to the lower line. Callers that pass no
	// nearLine get 0, which selects the first match as before.
	let markerLine = -1;
	let bestDistance = Infinity;
	for (let i = 0; i < lineCount; i++) {
		const line = editor.getLine(i);
		if (markers.some((m) => isMatch(line, m))) {
			const distance = Math.abs(i - nearLine);
			if (distance < bestDistance) {
				bestDistance = distance;
				markerLine = i;
			}
		}
	}

	if (markerLine === -1) {
		return null;
	}

	// Scan forward from the marker line to find the end of the callout block.
	// A callout block continues as long as lines start with `>`.
	let endLine = markerLine;
	for (let i = markerLine + 1; i < lineCount; i++) {
		const line = editor.getLine(i);
		if (line.startsWith(">")) {
			endLine = i;
		} else {
			break;
		}
	}

	return { from: markerLine, to: endLine };
}

/**
 * Find a callout block by query text.
 * Builds the possible header lines for `{query}` — the pending/active
 * `> [!claude] {query}` and the queued `> [!claude-queued] {query}` — and
 * searches the entire document for either. This is how poll callbacks
 * relocate the callout after the document has been edited, including after a
 * queued (#29) header rewrite.
 *
 * Returns inclusive {from, to} line numbers, or null if not found.
 */
export function findCalloutBlock(
	editor: Editor,
	query?: string,
	nearLine?: number
): { from: number; to: number } | null {
	const markers = query
		? [buildCalloutHeader(query), buildQueuedCalloutHeader(query)]
		: ["> [!claude] ", "> [!claude-queued] "];
	return findCalloutRange(editor, nearLine ?? 0, markers);
}

/**
 * Format milliseconds as human-readable elapsed time.
 * < 60s: "Ns" (e.g. "5s", "45s")
 * ≥ 60s: "Nm Ns" (e.g. "1m 0s", "2m 30s")
 * Always rounds down to the nearest second.
 */
export function formatElapsed(ms: number): string {
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m ${seconds}s`;
}

/**
 * Replace lines from..to (inclusive) with new content.
 */
export function replaceCalloutBlock(
	editor: Editor,
	from: number,
	to: number,
	newContent: string
): void {
	const fromPos: EditorPosition = { line: from, ch: 0 };
	const toPos: EditorPosition = {
		line: to,
		ch: editor.getLine(to).length,
	};
	editor.replaceRange(newContent, fromPos, toPos);
}


