import { Plugin } from "obsidian";

/**
 * Minimal plugin stub for P2 build.
 * Replaced by full main wiring in P3.
 */
export default class InlinePiPlugin extends Plugin {
	async onload(): Promise<void> {
		console.log("Inline Pi: P2 stub loaded");
	}

	onunload(): void {
		console.log("Inline Pi: P2 stub unloaded");
	}
}
