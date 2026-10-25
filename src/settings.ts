import { App, PluginSettingTab, Setting } from "obsidian";
import type { InlinePiSettings, InlinePiPluginLike } from "./types";

export { DEFAULT_SETTINGS } from "./types";
export type { InlinePiSettings } from "./types";

export class InlinePiSettingTab extends PluginSettingTab {
	plugin: InlinePiPluginLike;

	constructor(app: App, plugin: InlinePiPluginLike) {
		super(app, plugin as any);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Inline Pi settings" });

		new Setting(containerEl)
			.setName("Trigger phrase")
			.setDesc("Type this to open the pi chat dropdown.")
			.addText((text) =>
				text
					.setPlaceholder(";;")
					.setValue(this.plugin.settings.triggerPhrase)
					.onChange(async (value) => {
						this.plugin.settings.triggerPhrase = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Pi working directory")
			.setDesc(
				"Directory passed to pi as cwd. Leave blank to use the vault root. " +
					"Set to another path (e.g. your lab folder) so pi inherits that project's memory, skills, and MCP servers."
			)
			.addText((text) =>
				text
					.setPlaceholder("Vault root")
					.setValue(this.plugin.settings.workingDirectory)
					.onChange(async (value) => {
						this.plugin.settings.workingDirectory = value.trim();
						await this.plugin.saveSettings();
						// Push live to the running PiClient so the change takes effect on the
						// next ;; without a plugin reload (issue #4).
						this.plugin.setPiWorkingDirectory?.(value.trim());
					})
			);

		new Setting(containerEl)
			.setName("Response timeout (seconds)")
			.setDesc("How long to wait for pi to settle before showing a timeout error.")
			.addText((text) =>
				text
					.setPlaceholder("300")
					.setValue(String(this.plugin.settings.timeoutSecs))
					.onChange(async (value) => {
						const parsed = parseInt(value, 10);
						if (!isNaN(parsed) && parsed > 0) {
							this.plugin.settings.timeoutSecs = parsed;
							await this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("Enable debug log")
			.setDesc("Write detailed event logs to ~/.pi/inline-pi-debug.log for troubleshooting.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableDebugLog)
					.onChange(async (value) => {
						this.plugin.settings.enableDebugLog = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
