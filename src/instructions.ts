/**
 * Per-prompt instruction payload for D4 (per-prompt instructions only).
 * Derived from inline-claude's CLAUDE_MD_INSTRUCTIONS, minus channel/reply-tool mechanics.
 */

/**
 * The core instruction text to prepend to every prompt.
 * Contains the rules inherited from inline-claude.
 */
export const INSTRUCTIONS_PREFIX = `You are connected to an Obsidian vault, answering as an inline assistant.

## How this works

- The user types \`;;question\` inside an Obsidian note.
- Your response appears inline in the note as a callout block, with the query as its title.

## Instructions

- **Be concise but complete.** Your response renders inline in a note. Write clear, direct answers; markdown renders natively in Obsidian.
- **Always start with a text line.** Never begin with a table, code block, or other block-level markdown — the first line of your response is rendered under a label, so a block element there breaks. Start with a short text sentence.
- **Match the tone.** Casual question → casual answer; essay context → more polished.
- **No follow-up questions.** Give a complete answer in one reply; the user can ask again.
- **Answer from the context in front of you.** The note you're in is included below — don't read it again. You *do* have tools (web search, shell, and the rest of the vault's files) when the question genuinely needs live data or external context — but reach for them only then, and answer directly for a trivial or in-context question.
`;

/** Default ±window (in lines) around the cursor for note context. */
export const DEFAULT_WINDOW_RADIUS = 50;
/** Default cap (in characters) for the windowed note context. */
export const DEFAULT_MAX_CHARS = 8000;

export interface BuildNoteContextOptions {
	/** ±window radius around the cursor line (default: DEFAULT_WINDOW_RADIUS). */
	windowRadius?: number;
	/** Max characters of context before truncation (default: DEFAULT_MAX_CHARS). */
	maxChars?: number;
}

/**
 * Strip `> [!claude]` and `> [!claude-done]` callout blocks from note text.
 *
 * Walks the text line by line. When a line starts with `> [!claude]` or
 * `> [!claude-done]`, it enters skip mode and drops that line plus all
 * subsequent `>`-prefixed lines (the callout body). The first non-`>` line
 * exits skip mode and is kept. Other callout types (e.g. `> [!info]`) are
 * untouched. The blocks are stripped entirely — no `[elided]` marker — so
 * prior Q&A callouts don't leak into the model's context and get mimicked.
 *
 * Pure function: empty input → empty output.
 */
export function stripCalloutBlocks(text: string): string {
	const lines = text.split("\n");
	const result: string[] = [];
	let skipping = false;
	for (const line of lines) {
		if (line.startsWith("> [!claude]") || line.startsWith("> [!claude-done]")) {
			skipping = true;
			continue;
		}
		if (skipping) {
			if (line.startsWith(">")) continue;
			skipping = false;
		}
		result.push(line);
	}
	return result.join("\n");
}

/**
 * Build the note-context section of the prompt: a ±window of the note around
 * the cursor, with prior `> [!claude]` / `> [!claude-done]` callout blocks
 * stripped, truncated to a character cap, and labeled with the cursor line.
 *
 * Steps: (1) window the text around cursorLine, (2) strip callout blocks,
 * (3) truncate to maxChars with a `[…truncated]` tail if exceeded,
 * (4) prepend/append `[…above]`/`[…below]` markers when the window is
 * partial (not the whole note).
 *
 * Pure function.
 *
 * @param noteText Full text of the note
 * @param cursorLine 0-based cursor line number
 * @param options Optional windowRadius / maxChars overrides
 */
export function buildNoteContext(
	noteText: string,
	cursorLine: number,
	options: BuildNoteContextOptions = {}
): string {
	const {
		windowRadius = DEFAULT_WINDOW_RADIUS,
		maxChars = DEFAULT_MAX_CHARS,
	} = options;

	const lines = noteText.split("\n");
	const total = lines.length;

	// (1) Window around the cursor line (clamped to the note's bounds).
	const clampedCursor = Math.min(Math.max(cursorLine, 0), Math.max(total - 1, 0));
	const from = Math.max(0, clampedCursor - windowRadius);
	const to = Math.min(total - 1, clampedCursor + windowRadius);
	const hasAbove = from > 0;
	const hasBelow = to < total - 1;

	// (2) Strip prior callout blocks from the windowed text.
	let context = stripCalloutBlocks(lines.slice(from, to + 1).join("\n"));

	// (3) Truncate to the character cap.
	if (context.length > maxChars) {
		context = `${context.slice(0, maxChars)}\n[…truncated]`;
	}

	// (4) Mark partial windows.
	if (hasAbove) context = `[…above]\n${context}`;
	if (hasBelow) context = `${context}\n[…below]`;

	return `The note you're in (cursor at line ${cursorLine}):\n\n${context}`;
}

/**
 * Build the per-prompt instruction payload.
 * Returns the instructions prefix, the informational path/cursor line, and
 * the note context (a ±window of the note around the cursor, with prior
 * callout blocks stripped) so the model has the context without having to
 * read the file.
 *
 * @param notePath Absolute path to the note
 * @param cursorLine 0-based cursor line number
 * @param noteText Full text of the note at trigger time
 * @param question The user's question (optional). When provided and
 *   non-empty after trim, appended as a labeled `## Question` section after
 *   the note context so the model actually receives the question (#10).
 * @returns The full instruction text to send with the prompt
 */
export function buildPromptInstructions(
	notePath: string,
	cursorLine: number,
	noteText: string,
	question?: string
): string {
	const pathLine = `Note: \`${notePath}\` (cursor line ${cursorLine})`;
	const noteContext = buildNoteContext(noteText, cursorLine);
	const questionBlock =
		question && question.trim()
			? "\n## Question\n\n" + question.trim() + "\n"
			: "";
	return `${INSTRUCTIONS_PREFIX}\n${pathLine}\n\n${noteContext}${questionBlock}`;
}
