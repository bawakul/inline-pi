import { describe, it, expect } from "vitest";
import {
	INSTRUCTIONS_PREFIX,
	stripCalloutBlocks,
	buildNoteContext,
	buildPromptInstructions,
	DEFAULT_WINDOW_RADIUS,
	DEFAULT_MAX_CHARS,
} from "../instructions";

describe("stripCalloutBlocks", () => {
	it("strips a single > [!claude] block", () => {
		const input = [
			"Before",
			"> [!claude] What is X?",
			"> **Claude:** X is a thing.",
			"After",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("Before\nAfter");
	});

	it("strips a > [!claude-done]+ block (collapsed form)", () => {
		const input = [
			"Text",
			"> [!claude-done]+ Question?",
			"> **Claude:** Answer",
			"> more body",
			"",
			"Tail",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("Text\n\nTail");
	});

	it("keeps intervening text between multiple callouts", () => {
		const input = [
			"> [!claude] Q1",
			"> A1",
			"middle",
			"> [!claude] Q2",
			"> A2",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("middle");
	});

	it("leaves non-claude callouts (e.g. > [!info]) untouched", () => {
		const input = [
			"> [!info] A note",
			"> about something",
			"text",
			"> [!todo] stuff",
			"> - task",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe(input);
	});

	it("only matches the claude family (not similarly-named callouts)", () => {
		// "> [!claudeish]" must NOT be treated as a claude callout.
		const input = [
			"> [!claudeish] weird",
			"> body",
			"text",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe(input);
	});

	it("strips a callout at the start of the text", () => {
		const input = [
			"> [!claude] First?",
			"> Answer",
			"rest",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("rest");
	});

	it("strips a callout at the end of the text", () => {
		const input = [
			"start",
			"> [!claude-done]+ Last?",
			"> **Claude:** Bye",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("start");
	});

	it("strips a callout in the middle of the text", () => {
		const input = [
			"top",
			"> [!claude] Mid?",
			"> **Claude:** Middle answer",
			"bottom",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("top\nbottom");
	});

	it("strips adjacent callouts with no text between", () => {
		const input = [
			"> [!claude] Q1",
			"> A1",
			"> [!claude] Q2",
			"> A2",
		].join("\n");
		expect(stripCalloutBlocks(input)).toBe("");
	});

	it("returns empty output for empty input", () => {
		expect(stripCalloutBlocks("")).toBe("");
	});

	it("returns text unchanged when there are no callouts", () => {
		const input = ["just", "some", "lines"].join("\n");
		expect(stripCalloutBlocks(input)).toBe(input);
	});
});

describe("buildNoteContext", () => {
	function makeNote(n: number): string {
		return Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
	}

	it("returns the whole note (minus stripped callouts) when it fits in the window", () => {
		const note = [
			"intro",
			"> [!claude-done]+ earlier?",
			"> **Claude:** earlier answer",
			...makeNote(20).split("\n"),
		].join("\n");
		const result = buildNoteContext(note, 12);
		expect(result).toContain("intro");
		expect(result).toContain("line 0");
		expect(result).toContain("line 19");
		// Whole note → no window markers.
		expect(result).not.toContain("[…above]");
		expect(result).not.toContain("[…below]");
		// Prior callout stripped.
		expect(result).not.toContain("[!claude]");
	});

	it("windows ±windowRadius lines around the cursor on a large note", () => {
		const note = makeNote(200);
		const result = buildNoteContext(note, 100);
		expect(result).toContain("line 50");
		expect(result).toContain("line 100");
		expect(result).toContain("line 150");
		expect(result).not.toContain("line 49\n");
		expect(result).not.toContain("line 151\n");
		expect(result).not.toContain("line 0\n");
		expect(result).not.toContain("line 199\n");
	});

	it("does not go negative when the cursor is at line 0", () => {
		const note = makeNote(200);
		const result = buildNoteContext(note, 0);
		expect(result).toContain("line 0");
		expect(result).toContain("line 50");
		expect(result).not.toContain("[…above]");
		expect(result).toContain("[…below]");
	});

	it("ends at the last line when the cursor is at the last line", () => {
		const note = makeNote(200);
		const result = buildNoteContext(note, 199);
		expect(result).toContain("line 199");
		expect(result).toContain("line 149");
		expect(result).toContain("[…above]");
		expect(result).not.toContain("[…below]");
	});

	it("marks partial windows with […above]/[…below]", () => {
		const note = makeNote(500);
		const result = buildNoteContext(note, 250);
		expect(result).toContain("[…above]");
		expect(result).toContain("[…below]");
	});

	it("omits markers when the whole note fits in the window", () => {
		const note = makeNote(101);
		const result = buildNoteContext(note, 50);
		expect(result).not.toContain("[…above]");
		expect(result).not.toContain("[…below]");
		expect(result).toContain("line 0");
		expect(result).toContain("line 100");
	});

	it("truncates with […truncated] when the window exceeds maxChars", () => {
		const note = Array.from({ length: 5 }, () => "x".repeat(100)).join("\n");
		const result = buildNoteContext(note, 2, { maxChars: 50 });
		expect(result).toContain("[…truncated]");
	});

	it("strips callout blocks from the windowed output", () => {
		const top = Array.from({ length: 60 }, (_, i) => `line ${i}`);
		const bottom = Array.from({ length: 60 }, (_, i) => `line ${i + 60}`);
		const note = [
			...top,
			"> [!claude] old question",
			"> **Claude:** old answer",
			...bottom,
		].join("\n");
		// Note is 122 lines; callout sits at indices 60..61. Cursor at 57 with
		// radius 5 → window covers indices 52..62 (includes the whole callout).
		const result = buildNoteContext(note, 57, { windowRadius: 5 });
		expect(result).not.toContain("old question");
		expect(result).not.toContain("old answer");
		// Surrounding lines survive, including lines after the callout.
		expect(result).toContain("line 52");
		expect(result).toContain("line 60");
	});

	it("labels the context with the cursor line number", () => {
		const note = makeNote(10);
		const result = buildNoteContext(note, 42);
		expect(result).toContain("(cursor at line 42)");
	});

	it("uses DEFAULT_WINDOW_RADIUS (±50) and DEFAULT_MAX_CHARS (8000) by default", () => {
		expect(DEFAULT_WINDOW_RADIUS).toBe(50);
		expect(DEFAULT_MAX_CHARS).toBe(8000);
		const note = makeNote(101);
		const result = buildNoteContext(note, 50);
		// 101-line note at center cursor → whole note, no markers.
		expect(result).not.toContain("[…above]");
		expect(result).not.toContain("[…below]");
	});
});

describe("buildPromptInstructions", () => {
	const noteText = "Intro paragraph.\n\nSecond line of the note.";

	it("includes INSTRUCTIONS_PREFIX", () => {
		const instructions = buildPromptInstructions("/path/to/note.md", 5, noteText);
		expect(instructions).toContain(INSTRUCTIONS_PREFIX);
		expect(instructions).toContain("You are connected to an Obsidian vault.");
	});

	it("includes the note path and cursor line", () => {
		const instructions = buildPromptInstructions("/home/user/note.md", 10, noteText);
		expect(instructions).toContain("Note: `/home/user/note.md` (cursor line 10)");
	});

	it("includes the labeled note context with the note text", () => {
		const instructions = buildPromptInstructions("test.md", 0, noteText);
		expect(instructions).toContain("The note you're in (cursor at line 0):");
		expect(instructions).toContain("Intro paragraph.");
		expect(instructions).toContain("Second line of the note.");
	});

	it("does NOT include the 'Read the file first' instruction", () => {
		const instructions = buildPromptInstructions("test.md", 0, noteText);
		expect(instructions).not.toContain("Read the file first");
	});

	it("replaces 'You have full filesystem access' with the softened note-context line", () => {
		const instructions = buildPromptInstructions("test.md", 0, noteText);
		expect(instructions).not.toContain("You have full filesystem access");
		expect(instructions).toContain("The note you're in is included as context below");
		expect(instructions).toContain(
			"You can still read other files in the vault if the user's question asks for it."
		);
	});

	it("keeps the other instructions (no follow-up questions, match tone, start with text)", () => {
		const instructions = buildPromptInstructions("test.md", 0, noteText);
		expect(instructions).toContain("No follow-up questions.");
		expect(instructions).toContain("Match the tone.");
		expect(instructions).toContain("Always start with a text line.");
	});

	it("strips prior callout blocks from the embedded note context", () => {
		const withCallout = [
			"Writing about X.",
			"> [!claude-done]+ what is X?",
			"> **Claude:** X is a thing.",
			"More writing.",
		].join("\n");
		const instructions = buildPromptInstructions("test.md", 3, withCallout);
		expect(instructions).toContain("Writing about X.");
		expect(instructions).toContain("More writing.");
		expect(instructions).not.toContain("what is X?");
		expect(instructions).not.toContain("X is a thing.");
	});

	it("includes the user's question as a labeled section when provided (#10)", () => {
		const instructions = buildPromptInstructions(
			"/path/note.md",
			5,
			noteText,
			"weather report for Berlin"
		);
		expect(instructions).toContain("## Question");
		expect(instructions).toContain("weather report for Berlin");
	});

	it("does NOT include a question section when the question is omitted or undefined", () => {
		const omitted = buildPromptInstructions("/path/note.md", 5, noteText);
		expect(omitted).not.toContain("## Question");
		const explicitUndefined = buildPromptInstructions(
			"/path/note.md",
			5,
			noteText,
			undefined
		);
		expect(explicitUndefined).not.toContain("## Question");
	});
});
