import { Notice, Plugin, type EditorPosition, type TFile } from "obsidian";
import { PiClient, type PiClientOptions, type PiSettleResult, type PiActivity } from "./pi-client";
import { AbortWatcher } from "./abort-watcher";
import { InlinePiSuggest } from "./suggest";
import { InlinePiCanvasSuggest } from "./canvas-trigger";
import { InlinePiSettingTab } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
import { debugLog } from "./debug-log";
import { generateSessionId, isValidSessionId } from "./session-id";
import type { InlinePiPluginLike, InlinePiSettings } from "./types";

/**
 * Main plugin class for P3+.
 * Manages a single shared PiClient instance (D1: shared process),
 * maintains a status bar indicator.
 */
export default class InlinePiPlugin extends Plugin implements InlinePiPluginLike {
	services: { piClient: PiClient | null; abortWatcher: AbortWatcher | null } = {
		piClient: null,
		abortWatcher: null,
	};
	settings: InlinePiSettings = DEFAULT_SETTINGS;
	private statusBarEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// #42: establish the vault's stable pi session id once, then persist it.
		// A missing id means "ephemeral" (pre-#42 data.json) — generate one. An
		// invalid id (hand-edited data.json) would make pi exit(1) on spawn, so
		// regenerate rather than shipping it. Already-valid ids are never touched:
		// the id is thread identity, and it must survive reloads.
		if (!isValidSessionId(this.settings.sessionId)) {
			const previous = this.settings.sessionId;
			this.settings.sessionId = generateSessionId(this.app.vault.getName());
			await this.saveSettings();
			debugLog(
				`onload sessionId ${previous ? `invalid (${previous}) -> ` : "missing -> "}${this.settings.sessionId}`,
			);
		}

		// Wire settings tab
		this.addSettingTab(new InlinePiSettingTab(this.app, this));

		// Register suggest (markdown notes)
		this.registerEditorSuggest(new InlinePiSuggest(this));

		// Register canvas suggest (canvas nodes)
		this.registerEditorSuggest(new InlinePiCanvasSuggest(this));

		// Create status bar item
		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("ready", 0);

		// Initialize PiClient with single shared instance
		const clientOptions: PiClientOptions = this.createPiClientOptions();
		debugLog(`onload cwd=${clientOptions.workingDirectory} pi=${this.settings.piCommand || "auto"}`);
		debugLog(`onload enableDebugLog=${this.settings.enableDebugLog}`);
		debugLog(`onload sessionId=${this.settings.sessionId ?? "(none)"}`);
		this.services.piClient = new PiClient(clientOptions);

		// Initialize the abort-on-edit watcher (constructed after piClient exists).
		this.services.abortWatcher = new AbortWatcher(this.services.piClient);
		debugLog(`onload abortWatcher initialized`);

		// #42/#24: shed a stale thread without losing it — the old session file
		// stays on disk, the next ;; lazily spawns on the new id.
		this.addCommand({
			id: "fresh-pi-thread",
			name: "Inline Pi: Start fresh thread (old thread kept on disk)",
			callback: () => {
				void this.startFreshThread();
			},
		});

		console.log("Inline Pi plugin loaded");
	}

	onunload(): void {
		// Obsidian unload is sync; fire-and-forget shutdown with logged warning.
		// Guard against onload having thrown before services were populated.
		const client = this.services?.piClient;
		this.services?.abortWatcher?.stopAll();
		if (client) {
			void client.shutdown().catch(() => {
				console.warn("Inline Pi: shutdown did not complete before unload");
			});
			this.services.piClient = null;
		}
		console.log("Inline Pi plugin unloaded");
	}

	/** Expose the shared PiClient for P4 integration. */
	getPiClient(): PiClient | null {
		return this.services.piClient;
	}

	/** Expose the shared AbortWatcher so suggest/canvas can register pending callouts. */
	getAbortWatcher(): AbortWatcher | null {
		return this.services.abortWatcher;
	}

	/**
	 * Build PiClient options from current settings. Used on load and whenever the
	 * client is reconstructed (fresh thread). Settings changes that must apply to
	 * a *live* client (cwd, timeout) stay on their dedicated setters.
	 */
	private createPiClientOptions(): PiClientOptions {
		const vaultPath = this.getVaultPath();
		return {
			workingDirectory: this.settings.workingDirectory.trim() || vaultPath,
			timeoutMs: this.settings.timeoutSecs * 1000,
			sessionId: this.settings.sessionId,
			onStatusChange: (status, depth) => this.onPiStatusChange(status, depth),
			onDelta: (id, delta) => this.onPiDelta(id, delta),
			onActivity: (activity) => this.onPiActivity(activity),
			onSettle: (id, result) => this.onPiSettle(id, result),
			onExit: (code, signal) => this.onPiExit(code, signal),
			onLog: (msg) => this.onPiLog(msg),
		};
	}

	/**
	 * Start a fresh thread: regenerate the stable session id, shut the old pi
	 * process down, and construct a fresh client/watcher on the new id. The old
	 * session file is left intact on disk (issue #42, closes #24).
	 *
	 * Returns false when the request was refused (no client, or a run in flight).
	 */
	async startFreshThread(): Promise<boolean> {
		const oldClient = this.services.piClient;
		if (!oldClient) {
			new Notice("Inline Pi: pi client is not ready — reload the plugin first.");
			return false;
		}
		if (oldClient.isBusy()) {
			new Notice(
				"Inline Pi: pi is busy — wait for the current ;; to settle (or delete the pending callout to abort) before starting a fresh thread.",
			);
			return false;
		}

		const previousId = this.settings.sessionId;
		this.settings.sessionId = generateSessionId(this.app.vault.getName());
		await this.saveSettings();

		// Drop pending callout bookkeeping, then recycle the process. shutdown()
		// is terminal for a PiClient, so the client is reconstructed, not reused.
		this.services.abortWatcher?.stopAll();
		await oldClient.shutdown();

		this.services.piClient = new PiClient(this.createPiClientOptions());
		this.services.abortWatcher = new AbortWatcher(this.services.piClient);
		this.updateStatusBar("ready", 0, "");

		debugLog(
			`fresh thread: sessionId ${previousId ?? "(none)"} -> ${this.settings.sessionId} (old session kept on disk)`,
		);
		new Notice(
			`Inline Pi: fresh thread started. Previous session${previousId ? ` (${previousId})` : ""} is kept on disk.`,
		);
		return true;
	}

	// --- PiClient event handlers ---

	private onPiStatusChange(status: "dead" | "ready" | "busy", depth: number): void {
		this.updateStatusBar(status, depth);
	}

	private byteCount = 0;

	/** Activity signal (thinking/tool) drives the status-bar detail — issue #6. */
	private onPiActivity(activity: PiActivity): void {
		if (activity.phase === "thinking") {
			this.updateStatusBar("busy", 0, "thinking…");
		} else if (activity.phase === "tool") {
			const name = activity.toolName ?? "tool";
			const n = activity.toolCount ?? 0;
			this.updateStatusBar("busy", 0, n > 1 ? `${name} ×${n}` : name);
		}
		// "responding" is driven by onDelta's byte-count detail; "idle" by onSettle.
	}

	private onPiDelta(id: string, delta: string): void {
		// Per-prompt handlers route directly; this callback (from PiClientOptions.onDelta)
		// is kept for logging/debugging only. The event bridge is handled via per-prompt
		// handlers passed to prompt() in suggest.ts and canvas-trigger.ts.
		console.log(`[pi-delta] ${id}: ${delta}`);
		this.byteCount += delta.length;
		this.updateStatusBar("busy", 0, this.humanizeByteCount(this.byteCount));
	}

	private humanizeByteCount(bytes: number): string {
		if (bytes < 1000) return `${bytes}`;
		return `${(bytes / 1000).toFixed(1)}k`;
	}

	private onPiSettle(id: string, result: PiSettleResult): void {
		// Per-prompt handlers route directly; this callback (from PiClientOptions.onSettle)
		// is kept for logging/debugging only. The event bridge is handled via per-prompt
		// handlers passed to prompt() in suggest.ts and canvas-trigger.ts.
		console.log(`[pi-settle] ${id}: aborted=${result.aborted}, error=${result.error}`);
		// Reset byte count and detail on settle
		this.byteCount = 0;
		this.updateStatusBar(result.error ? "dead" : "ready", 0);
	}

	private onPiExit(code: number | null, signal: string | null): void {
		console.log(`[pi-exit] code=${code} signal=${signal}`);
		// If the process died unexpectedly, update status with reason
		let reason = "exited";
		if (signal) reason = `signal=${signal}`;
		else if (code !== null) reason = `code=${code}`;
		this.updateStatusBar("dead", 0, reason);
	}

	private onPiLog(message: string): void {
		console.log(`[pi-client] ${message}`);
		debugLog(`[pi-client] ${message}`);

		// Drive status bar detail from log messages
		if (message.includes("thinking (")) {
			// Thinking state
			this.updateStatusBar("busy", 0, "thinking…");
		} else if (message.includes("spawn error:")) {
			// Error state
			this.updateStatusBar("dead", 0, "spawn error");
		}
	}

	// --- Status bar ---

	private statusBarState = {
		status: "ready" as "dead" | "ready" | "busy",
		depth: 0,
		detail: "",
	};

	private updateStatusBar(status?: "dead" | "ready" | "busy", depth?: number, detail?: string): void {
		if (!this.statusBarEl) return;

		if (status !== undefined) this.statusBarState.status = status;
		if (depth !== undefined) this.statusBarState.depth = depth;
		if (detail !== undefined) this.statusBarState.detail = detail;

		const { status: s, depth: d, detail: det } = this.statusBarState;
		let icon = "⚫"; // dead
		if (s === "ready") icon = "🟢";
		else if (s === "busy") icon = "⏳";

		let text = `${icon} Inline Pi`;
		if (det) {
			text += ` · ${det}`;
		} else if (d > 0) {
			text += ` (${d} queued)`;
		}
		this.statusBarEl.setText(text);
	}

	// --- Settings ---

	/**
	 * Push a settings working-directory change to the running PiClient so it takes
	 * effect on the next ;; without a full plugin reload. Resolves the vault
	 * root when the setting is blank. See issue #4 and PiClient.setWorkingDirectory.
	 */
	setPiWorkingDirectory(dir: string): void {
		const effective = dir.trim() || this.getVaultPath();
		this.services.piClient?.setWorkingDirectory(effective);
		debugLog(`setPiWorkingDirectory: ${effective || "(vault root)"}`);
	}

	/**
	 * Push a settings timeout change to the running PiClient so the next ;;
	 * arms its watchdog with the new value without a plugin reload. See
	 * issue #40 and PiClient.setTimeoutMs.
	 */
	setPiTimeoutSecs(secs: number): void {
		this.services.piClient?.setTimeoutMs(secs * 1000);
		debugLog(`setPiTimeoutSecs: ${secs}s`);
	}

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
		import("./debug-log").then(({ setDebugLogEnabled }) => {
			setDebugLogEnabled(this.settings.enableDebugLog);
		});
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		import("./debug-log").then(({ setDebugLogEnabled }) => {
			setDebugLogEnabled(this.settings.enableDebugLog);
		});
	}
}
