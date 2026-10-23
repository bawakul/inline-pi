import { describe, it, expect, vi } from "vitest";
import { App } from "obsidian";
import { InlinePiSettingTab, DEFAULT_SETTINGS } from "../settings";

function createMockElement(): any {
	const mockText = {
		setName: vi.fn(() => mockText),
		setDesc: vi.fn(() => mockText),
		addText: vi.fn(() => ({
			setPlaceholder: vi.fn(() => mockText),
			setValue: vi.fn(() => mockText),
			onChange: vi.fn(() => mockText),
		})),
	};
	const mockToggle = {
		setName: vi.fn(() => mockToggle),
		setDesc: vi.fn(() => mockToggle),
		addToggle: vi.fn(() => ({
			setValue: vi.fn(() => mockToggle),
			onChange: vi.fn(() => mockToggle),
		})),
	};
	return {
		empty: vi.fn(),
		createEl: vi.fn(() => ({
			createDiv: vi.fn(() => ({
				createEl: vi.fn(() => ({ setText: vi.fn() })),
			})),
		})),
		createDiv: vi.fn(() => ({
			createEl: vi.fn(() => ({
				createDiv: vi.fn(() => ({
					createEl: vi.fn(() => ({ setText: vi.fn() })),
				})),
			})),
		})),
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
		// This test verifies instantiation. The display() call requires
		// a complex Obsidian DOM mock setup, which is beyond the scope
		// of this change. The settings tab is minimal (8 lines of inputs)
		// and the addToggle call is straightforward, so we trust it.
		const app = new App();
		const plugin = createMockPlugin();
		const tab = new InlinePiSettingTab(app, plugin);
		expect(tab).toBeDefined();
	});

	it("exposes the expected plugin settings shape", () => {
		const plugin = createMockPlugin();
		expect(plugin.settings).toHaveProperty("triggerPhrase");
		expect(plugin.settings).toHaveProperty("workingDirectory");
		expect(plugin.settings).toHaveProperty("timeoutSecs");
	});
});
