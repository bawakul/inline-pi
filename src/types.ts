import type { App } from "obsidian";

export interface InlinePiSettings {
	triggerPhrase: string;
	/** Empty string means "use vault root". */
	workingDirectory: string;
	timeoutSecs: number;
	/** Enable/disable file-based debug log. */
	enableDebugLog: boolean;
	/** Optional explicit pi executable; otherwise resolved from PATH. */
	piCommand?: string;
}

export const DEFAULT_SETTINGS: InlinePiSettings = {
	triggerPhrase: ";;",
	workingDirectory: "",
	timeoutSecs: 300,
	enableDebugLog: true,
	piCommand: undefined,
};

/**
 * Minimal plugin shape used by settings/suggest/callout while main.ts is
 * still being ported. Replaced by the real plugin class once P3 lands.
 */
export interface InlinePiPluginLike {
	app: App;
	settings: InlinePiSettings;
	saveSettings(): Promise<void>;
	/** Push a settings working-directory change to the running PiClient (issue #4). */
	setPiWorkingDirectory?(dir: string): void;
	/** Event hooks for P4 callout/streaming (optional). */
	hooks?: { onSettle?: (file: any, cursor: any, result: any) => void; onDelta?: (file: any, cursor: any, delta: string) => void };
}
