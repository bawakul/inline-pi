import type { Editor } from "obsidian";
import type { PiClient } from "./pi-client";
import { findCalloutBlock, buildCalloutHeader } from "./callout";

/**
 * Abort-watcher for pending callouts.
 * 
 * When a pending callout is inserted, the watcher tracks it by calloutId.
 * When the note is modified, the watcher checks if the callout's header
 * line `> [!claude] {query}` still exists unchanged. If gone or changed,
 * the pi-client is aborted.
 * 
 * The plugin is responsible for registering editor change handlers and
 * calling `checkCalloutHeader()` for relevant callouts on each change.
 * 
 * Suppression during plugin's own writes is achieved via `beginFlush()`/`endFlush()`.
 */
export class AbortWatcher {
	// Map of calloutId -> { notePath, query, calloutLine } for tracking pending callouts
	private pendingCallouts: Map<string, { notePath: string; query: string; calloutLine: number }> = new Map();
	private flushPending: Set<string> = new Set(); // Files with pending flushes
	private flushTimeouts: Map<string, NodeJS.Timeout> = new Map();

	constructor(private piClient: PiClient | null) {}

	/**
	 * Register a pending callout to be watched.
	 * @param calloutId - Unique id for this callout
	 * @param notePath - Absolute path of the note
	 * @param query - The user's prompt query
	 * @param calloutLine - The line number where the callout header was inserted
	 */
	public registerPendingCallout(
		calloutId: string,
		notePath: string,
		query: string,
		calloutLine: number
	): void {
		this.pendingCallouts.set(calloutId, { notePath, query, calloutLine });
		console.log(`[abort-watcher] Registered pending callout ${calloutId} at line ${calloutLine}`);
	}

	/**
	 * Unregister a callout (when it settles or is aborted).
	 * @param calloutId - The callout's unique id
	 */
	public unregisterCallout(calloutId: string): void {
		this.pendingCallouts.delete(calloutId);
		console.log(`[abort-watcher] Unregistered callout ${calloutId}`);
	}

	/**
	 * Mark a file as having a pending flush. Edits during this time
	 * will be suppressed from triggering abort checks.
	 * @param notePath - Path of the file being flushed
	 */
	public beginFlush(notePath: string): void {
		this.flushPending.add(notePath);
		
		// Clear any existing timeout for this file
		const existingTimeout = this.flushTimeouts.get(notePath);
		if (existingTimeout) {
			clearTimeout(existingTimeout);
		}
		
		// Set a timeout to clear the flush flag after a brief period
		// (assuming the flush completes within 100ms)
		const timeout = setTimeout(() => {
			this.flushPending.delete(notePath);
			this.flushTimeouts.delete(notePath);
		}, 100);
		this.flushTimeouts.set(notePath, timeout);
	}

	/**
	 * End a flush period. Called automatically after beginFlush timeout.
	 * @param notePath - Path of the file
	 */
	public endFlush(notePath: string): void {
		this.flushPending.delete(notePath);
		const timeout = this.flushTimeouts.get(notePath);
		if (timeout) {
			clearTimeout(timeout);
			this.flushTimeouts.delete(notePath);
		}
	}

	/**
	 * Check if any pending callout's header has been modified or deleted.
	 * Should be called by the plugin on editor change events.
	 * @param editor - The editor instance
	 * @returns true if all headers are intact, false if abort was triggered
	 */
	public checkAllCallouts(editor: Editor): boolean {
		// If any file has a pending flush, skip checks
		if (this.flushPending.size > 0) {
			return true;
		}

		let abortTriggered = false;
		
		for (const [calloutId, { notePath, query, calloutLine }] of this.pendingCallouts.entries()) {
			if (!this.checkSingleCallout(editor, calloutId, query, calloutLine)) {
				abortTriggered = true;
			}
		}

		return !abortTriggered;
	}

	/**
	 * Check a single callout's header.
	 * @param editor - The editor instance
	 * @param calloutId - The callout's unique id
	 * @param query - The user's prompt query
	 * @param calloutLine - The expected line number of the callout header
	 * @returns true if header is intact, false if abort was triggered
	 */
	public checkSingleCallout(
		editor: Editor,
		calloutId: string,
		query: string,
		calloutLine: number
	): boolean {
		// If a flush is pending for this file, skip check
		// Note: since Editor doesn't expose file path, we rely on plugin to suppress via flushPending
		if (this.flushPending.size > 0) {
			return true;
		}

		const expectedHeader = buildCalloutHeader(query);
		const range = findCalloutBlock(editor, query);
		
		if (!range) {
			// Header not found
			console.log(`[abort-watcher] Header not found for ${calloutId}, aborting`);
			void this.piClient?.abort().catch(() => {
				console.warn(`[abort-watcher] Abort failed for ${calloutId}`);
			});
			return false;
		}

		// Check if the header line matches exactly
		const headerLine = editor.getLine(range.from);
		if (headerLine !== expectedHeader) {
			console.log(`[abort-watcher] Header changed for ${calloutId}, aborting`);
			void this.piClient?.abort().catch(() => {
				console.warn(`[abort-watcher] Abort failed for ${calloutId}`);
			});
			return false;
		}

		return true;
	}

	/**
	 * Abort a specific callout by id.
	 * @param calloutId - The callout's unique id
	 */
	public abort(calloutId: string): void {
		const callout = this.pendingCallouts.get(calloutId);
		if (callout) {
			console.log(`[abort-watcher] Abort requested for ${calloutId} (query: ${callout.query})`);
		}
		void this.piClient?.abort().catch(() => {
			console.warn(`[abort-watcher] Abort failed`);
		});
	}

	/**
	 * Stop watching all callouts.
	 */
	public stopAll(): void {
		this.pendingCallouts.clear();
		
		// Clear all flush timeouts
		for (const [, timeout] of this.flushTimeouts.entries()) {
			clearTimeout(timeout);
		}
		this.flushTimeouts.clear();
		this.flushPending.clear();
	}

	/**
	 * Get the number of pending callouts being watched.
	 */
	public getPendingCount(): number {
		return this.pendingCallouts.size;
	}
}
