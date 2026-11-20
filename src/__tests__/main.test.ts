import { describe, it, expect, beforeEach, vi } from "vitest";
import { App, Notice } from "obsidian";
import InlinePiPlugin from "../main";
import { isValidSessionId } from "../session-id";

/**
 * Plugin-level tests for the #42 session wiring: stable id generation on load,
 * pass-through to the client, and the fresh-thread command guards/flow.
 *
 * No process is ever spawned here: PiClient only spawns on the first prompt.
 */
function createPlugin(initialData: Record<string, unknown> = {}) {
	const app = new App();
	const plugin = new InlinePiPlugin(app as any, { id: "inline-pi" } as any);
	const saved: Array<Record<string, unknown>> = [];

	(plugin as any).loadData = vi.fn(async () => ({ ...initialData }));
	(plugin as any).saveData = vi.fn(async (data: Record<string, unknown>) => {
		saved.push({ ...data });
	});

	return { plugin, app, saved };
}

function clientOpts(plugin: InlinePiPlugin): any {
	return (plugin.getPiClient() as any)?.opts;
}

describe("Inline Pi plugin — stable session id (#42)", () => {
	beforeEach(() => {
		Notice.reset();
	});

	it("generates and persists a valid session id on first load", async () => {
		const { plugin, saved } = createPlugin();
		await plugin.onload();

		expect(isValidSessionId(plugin.settings.sessionId)).toBe(true);
		expect(plugin.settings.sessionId).toMatch(/^inline-pi-test-vault-/);
		// Persisted immediately, so the id survives this reload.
		expect(saved.length).toBe(1);
		expect(saved[0].sessionId).toBe(plugin.settings.sessionId);
	});

	it("keeps an existing valid id across reloads (thread identity is stable)", async () => {
		const existing = "inline-pi-bawa-s-lab-abc123";
		const { plugin, saved } = createPlugin({ sessionId: existing });
		await plugin.onload();

		expect(plugin.settings.sessionId).toBe(existing);
		expect(saved.length).toBe(0); // nothing to persist
	});

	it("regenerates an invalid id rather than letting pi exit(1)", async () => {
		const { plugin, saved } = createPlugin({ sessionId: "-not-valid-" });
		await plugin.onload();

		expect(isValidSessionId(plugin.settings.sessionId)).toBe(true);
		expect(plugin.settings.sessionId).not.toBe("-not-valid-");
		expect(saved[0].sessionId).toBe(plugin.settings.sessionId);
	});

	it("passes the id through to the PiClient", async () => {
		const existing = "inline-pi-bawa-s-lab-abc123";
		const { plugin } = createPlugin({ sessionId: existing });
		await plugin.onload();

		expect(clientOpts(plugin).sessionId).toBe(existing);
	});

	it("registers the fresh-thread command", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();

		const commands = (plugin as any).commands as any[];
		const command = commands.find((c) => c.id === "fresh-pi-thread");
		expect(command).toBeDefined();
		expect(command.name).toBe("Inline Pi: Start fresh thread (old thread kept on disk)");
		expect(typeof command.callback).toBe("function");
	});
});

describe("startFreshThread (#42 / #24)", () => {
	beforeEach(() => {
		Notice.reset();
	});

	it("refuses when there is no client, with a Notice", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		const before = plugin.settings.sessionId;
		plugin.services.piClient = null;

		await expect(plugin.startFreshThread()).resolves.toBe(false);
		expect(plugin.settings.sessionId).toBe(before);
		expect(Notice.instances.at(-1)?.message).toContain("not ready");
	});

	it("refuses while pi is busy, without touching the id or the process", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		const before = plugin.settings.sessionId;
		const shutdown = vi.fn(async () => {});
		plugin.services.piClient = { isBusy: () => true, shutdown } as any;

		await expect(plugin.startFreshThread()).resolves.toBe(false);
		expect(plugin.settings.sessionId).toBe(before);
		expect(shutdown).not.toHaveBeenCalled();
		expect(Notice.instances.at(-1)?.message).toContain("busy");
	});

	it("regenerates the id, recycles the client, and keeps the old thread on disk", async () => {
		const { plugin, saved } = createPlugin();
		await plugin.onload();
		const before = plugin.settings.sessionId!;
		const oldClient = plugin.getPiClient();
		const shutdown = vi.fn(async () => {});
		plugin.services.piClient = {
			isBusy: () => false,
			shutdown,
		} as any;
		const stopAll = vi.fn();
		plugin.services.abortWatcher = { stopAll } as any;

		await expect(plugin.startFreshThread()).resolves.toBe(true);

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(stopAll).toHaveBeenCalledTimes(1);
		expect(plugin.settings.sessionId).not.toBe(before);
		expect(isValidSessionId(plugin.settings.sessionId)).toBe(true);
		expect(saved.at(-1)?.sessionId).toBe(plugin.settings.sessionId);
		// Fresh client, built from the new settings, new watcher.
		expect(plugin.getPiClient()).not.toBe(oldClient);
		expect(clientOpts(plugin).sessionId).toBe(plugin.settings.sessionId);
		expect(plugin.getAbortWatcher()).not.toBeNull();
		expect(Notice.instances.at(-1)?.message).toContain("fresh thread");
	});
});
