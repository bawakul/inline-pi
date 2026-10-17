import type { App } from "obsidian";

export interface InlinePiSettings {
	triggerPhrase: string;
	/** Empty string means "use vault root". */
	workingDirectory: string;
	timeoutSecs: number;
}

export const DEFAULT_SETTINGS: InlinePiSettings = {
	triggerPhrase: ";;",
	workingDirectory: "",
	timeoutSecs: 300,
};

/**
 * Minimal plugin shape used by settings/suggest/callout while main.ts is
 * still being ported. Replaced by the real plugin class once P3 lands.
 */
export interface InlinePiPluginLike {
	app: App;
	settings: InlinePiSettings;
	saveSettings(): Promise<void>;
}
