import { describe, it, expect, vi } from "vitest";
import { App } from "obsidian";
import { InlinePiSettingTab, DEFAULT_SETTINGS } from "../settings";

function createMockElement(): any {
	return {
		empty: vi.fn(),
		createEl: vi.fn(() => createMockElement()),
		createDiv: vi.fn(() => createMockElement()),
		setText: vi.fn(),
		addEventListener: vi.fn(),
	};
}

function createMockPlugin(overrides: Record<string, any> = {}): any {
	return {
		app: new App(),
		settings: { ...DEFAULT_SETTINGS },
		saveSettings: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("DEFAULT_SETTINGS", () => {
	it("matches the M1 spec defaults", () => {
		expect(DEFAULT_SETTINGS.triggerPhrase).toBe(";;");
		expect(DEFAULT_SETTINGS.workingDirectory).toBe("");
		expect(DEFAULT_SETTINGS.timeoutSecs).toBe(300);
	});
});

describe("InlinePiSettingTab", () => {
	it("can be instantiated and displayed without throwing", () => {
		const app = new App();
		const plugin = createMockPlugin();
		const tab = new InlinePiSettingTab(app, plugin);
		(tab as any).containerEl = createMockElement();

		expect(() => tab.display()).not.toThrow();
	});

	it("exposes the expected plugin settings shape", () => {
		const plugin = createMockPlugin();
		expect(plugin.settings).toHaveProperty("triggerPhrase");
		expect(plugin.settings).toHaveProperty("workingDirectory");
		expect(plugin.settings).toHaveProperty("timeoutSecs");
	});
});
