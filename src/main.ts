import { Plugin, type EditorPosition, type TFile } from "obsidian";
import { PiClient, type PiClientOptions, type PiSettleResult } from "./pi-client";
import { InlinePiSuggest } from "./suggest";
import { InlinePiSettingTab } from "./settings";
import type { InlinePiPluginLike, InlinePiSettings } from "./types";

/**
 * Event hook surface for P4 callout/streaming hooks.
 * Each hook receives a reference to the active callout or plugin-level event.
 */
export interface InlinePiEventHooks {
	onDelta?: (file: TFile | null, cursor: EditorPosition, delta: string) => void;
	onSettle?: (
		file: TFile | null,
		cursor: EditorPosition,
		result: PiSettleResult
	) => void;
}

/**
 * Main plugin class for P3+.
 * Manages a single shared PiClient instance (D1: shared process),
 * maintains a status bar indicator, and exposes hooks for P4 callout streaming.
 */
export default class InlinePiPlugin extends Plugin implements InlinePiPluginLike {
	settings: InlinePiSettings;
	private piClient: PiClient | null = null;
	private statusBarEl: HTMLElement | null = null;
	private hooks: InlinePiEventHooks = {};

	async onload(): Promise<void> {
		await this.loadSettings();

		// Wire settings tab
		this.addSettingTab(new InlinePiSettingTab(this.app, this));

		// Register suggest (stubbed in P1, dispatch logic in P4)
		this.registerEditorSuggest(new InlinePiSuggest(this));

		// Create status bar item
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("ready", 0);

		// Initialize PiClient with single shared instance
		const vaultPath = this.getVaultPath();
		const clientOptions: PiClientOptions = {
			workingDirectory:
				this.settings.workingDirectory.trim() || vaultPath,
			timeoutMs: this.settings.timeoutSecs * 1000,
			onStatusChange: (status, depth) => this.onPiStatusChange(status, depth),
			onDelta: (id, delta) => this.onPiDelta(id, delta),
			onSettle: (id, result) => this.onPiSettle(id, result),
			onExit: (code, signal) => this.onPiExit(code, signal),
			onLog: (msg) => this.onPiLog(msg),
		};
		this.piClient = new PiClient(clientOptions);

		console.log("Inline Pi plugin loaded");
	}

	onunload(): void {
		// Obsidian unload is sync; fire-and-forget shutdown with logged warning
		void this.piClient?.shutdown().catch(() => {
			console.warn("Inline Pi: shutdown did not complete before unload");
		});
		this.piClient = null;
		console.log("Inline Pi plugin unloaded");
	}

	/** Expose the shared PiClient for P4 integration. */
	getPiClient(): PiClient | null {
		return this.piClient;
	}

	/** Register P4 callout/streaming hooks. */
	registerEventHooks(hooks: InlinePiEventHooks): void {
		this.hooks = hooks;
	}

	// --- PiClient event handlers ---

	private onPiStatusChange(status: "dead" | "ready" | "busy", depth: number): void {
		this.updateStatusBar(status, depth);
	}

	private onPiDelta(id: string, delta: string): void {
		// P4 will use this to stream text into the active callout
		// For now, just log for visibility
		console.log(`[pi-delta] ${id}: ${delta}`);
		if (this.hooks.onDelta) {
			// P4 will infer the active callout from context; pass null here for now
			this.hooks.onDelta(null, { line: 0, ch: 0 }, delta);
		}
	}

	private onPiSettle(id: string, result: PiSettleResult): void {
		// P4 will use this to finalize the callout state
		console.log(`[pi-settle] ${id}: aborted=${result.aborted}, error=${result.error}`);
		if (this.hooks.onSettle) {
			this.hooks.onSettle(null, { line: 0, ch: 0 }, result);
		}
	}

	private onPiExit(code: number | null, signal: string | null): void {
		console.log(`[pi-exit] code=${code} signal=${signal}`);
		// If the process died unexpectedly, update status
		this.updateStatusBar("dead", 0);
	}

	private onPiLog(message: string): void {
		console.log(`[pi-client] ${message}`);
	}

	// --- Status bar ---

	private updateStatusBar(status: "dead" | "ready" | "busy", depth: number): void {
		if (!this.statusBarEl) return;

		let icon = "⚫"; // dead
		if (status === "ready") icon = "🟢";
		else if (status === "busy") icon = "⏳";

		let text = `${icon} Inline Pi`;
		if (depth > 0) {
			text += ` (${depth} queued)`;
		}
		this.statusBarEl.setText(text);
	}

	// --- Settings ---

	private getVaultPath(): string {
		const adapter = this.app.vault.adapter;
		// getBasePath() exists for local vaults; return empty for cloud vaults
		if ("getBasePath" in adapter && typeof adapter.getBasePath === "function") {
			return adapter.getBasePath();
		}
		return "";
	}

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, this.settings, data);
		if (!this.settings.workingDirectory.trim()) {
			this.settings.workingDirectory = "";
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
