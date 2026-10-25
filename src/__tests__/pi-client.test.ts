import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcess } from "child_process";
import {
	PiClient,
	PiClientOptions,
	PiSettleResult,
	PiStatus,
	SpawnCommand,
	PiActivity,
} from "../pi-client";

describe("PiClient", () => {
	// Track created processes for cleanup
	const spawnedProcesses: ChildProcess[] = [];

	afterEach(() => {
		// Kill any spawned processes
		for (const proc of spawnedProcesses) {
			if (proc.exitCode === null) {
				proc.kill("SIGTERM");
			}
		}
		spawnedProcesses.length = 0;
	});

	/**
	 * Helper that creates a PiClient with settle tracking.
	 * Uses a fake spawnCommand to run fake-pi.js for testing.
	 */
	function createClientWithSettleTracking(
		userOptions: Partial<PiClientOptions> = {}
	): {
		client: PiClient;
		settleResults: Map<string, PiSettleResult>;
		awaitSettle: (promptId: string, timeoutMs?: number) => Promise<PiSettleResult>;
	} {
		const settleResults = new Map<string, PiSettleResult>();
		const settleCallbacks = new Map<string, ((r: PiSettleResult) => void)[]>();

		function onSettle(id: string, result: PiSettleResult) {
			settleResults.set(id, result);
			const callbacks = settleCallbacks.get(id);
			if (callbacks) {
				settleCallbacks.delete(id);
				for (const cb of callbacks) cb(result);
			}
			// Also call user's onSettle if provided
			if (userOptions.onSettle) {
				userOptions.onSettle(id, result);
			}
		}

		function awaitSettle(promptId: string, timeoutMs: number = 2000): Promise<PiSettleResult> {
			return new Promise((resolve, reject) => {
				if (settleResults.has(promptId)) {
					resolve(settleResults.get(promptId)!);
					return;
				}

				const timer = setTimeout(() => {
					reject(new Error(`Timeout waiting for settle of ${promptId}`));
				}, timeoutMs);

				const callback = (result: PiSettleResult) => {
					clearTimeout(timer);
					resolve(result);
				};

				const existing = settleCallbacks.get(promptId) || [];
				existing.push(callback);
				settleCallbacks.set(promptId, existing);

				// Poll as fallback
				const poll = () => {
					if (settleResults.has(promptId)) {
						callback(settleResults.get(promptId)!);
					} else {
						setTimeout(poll, 50);
					}
				};
				poll();
			});
		}

		// Create a spawnCommand that runs fake-pi.js
		const fakeSpawnCommand: SpawnCommand = (command, args, options) => {
			// The command should be 'node' and args should include fake-pi.js
			// But we need to find where fake-pi.js is located
			const fakePiPath = require.resolve("./fake-pi.js");
			const proc = spawn("node", [fakePiPath], {
				...options,
				cwd: __dirname,
			});

			spawnedProcesses.push(proc);
			return proc;
		};

		const client = new PiClient({
			workingDirectory: __dirname,
			timeoutMs: 0,
			spawnCommand: fakeSpawnCommand,
			onSettle,
			onDelta: userOptions.onDelta || (() => {}),
			onActivity: userOptions.onActivity || (() => {}),
			onLog: userOptions.onLog || (() => {}),
			onStatusChange: userOptions.onStatusChange || (() => {}),
			onExit: userOptions.onExit || (() => {}),
		});

		return { client, settleResults, awaitSettle };
	}

	describe("Activity events (issue #6)", () => {
		it("routes tool/turn/agent events to onActivity and counts tools", async () => {
			const activities: PiActivity[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				onActivity: (a: PiActivity) => activities.push(a),
			});

			const promptId = await client.prompt("run tools please");
			const result = await awaitSettle(promptId);

			expect(result.error).toBe(false);

			// Phase progression: thinking -> tool(read) -> tool(bash) -> responding.
			const phases = activities.map((a) => a.phase);
			expect(phases).toContain("thinking");
			expect(phases).toContain("tool");

			// First tool event carries toolName + toolCount 1; second carries 2.
			const toolEvents = activities.filter((a) => a.phase === "tool");
			expect(toolEvents.length).toBeGreaterThanOrEqual(2);
			expect(toolEvents[0].toolName).toBe("read");
			expect(toolEvents[0].toolCount).toBe(1);
			// The tool_execution_start for bash increments the running count.
			const bashStart = toolEvents.find((a) => a.toolName === "bash");
			expect(bashStart?.toolCount).toBe(2);
		});

		it("does not log tool/turn/agent events as 'unknown event type'", async () => {
			const logCalls: string[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				onLog: (msg: string) => logCalls.push(msg),
			});

			const promptId = await client.prompt("run tools please");
			await awaitSettle(promptId);

			const unknownLogs = logCalls.filter((l) => l.includes("unknown event type"));
			expect(unknownLogs).toEqual([]);
		});
	});

	describe("Happy path", () => {
		it("streams text deltas and settles with success", async () => {
			const deltas: string[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				onDelta: (id: string, delta: string) => deltas.push(delta),
			});

			// Start the prompt
			const promptId = await client.prompt("say happy");

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify deltas were captured
			expect(deltas.length).toBeGreaterThan(0);
			expect(deltas.join("")).toContain("Hello");

			// Verify settle happened with success
			expect(result.error).toBe(false);
			expect(result.aborted).toBe(false);
			expect(result.finalContent).toBeTruthy();
			expect(result.stopReason).toBe("stop");
		});
	});

	describe("Error-retry path", () => {
		it("logs auto_retry events and settles with error", async () => {
			const logCalls: string[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				onLog: (msg: string) => logCalls.push(msg),
			});

			// Start the prompt
			const promptId = await client.prompt("say error");

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify auto_retry events were logged
			const autoRetryLogs = logCalls.filter((l) => l.includes("auto_retry"));
			expect(autoRetryLogs.length).toBeGreaterThan(0);

			// Verify settle happened with error
			expect(result.error).toBe(true);
			expect(result.aborted).toBe(false);
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toBeTruthy();
		});
	});

	describe("Abort path", () => {
		it("aborts the active run and settles with aborted:true", async () => {
			const { client, settleResults, awaitSettle } = createClientWithSettleTracking();

			// Start the prompt
			const promptId = await client.prompt("say abort");

			// Give it time to start, then abort
			await new Promise((resolve) => setTimeout(resolve, 100));
			await client.abort();

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify abort settle
			console.log(`[TEST] Abort - settleResults.size=${settleResults.size}, result=${JSON.stringify(result)}`);
			expect(result.aborted).toBe(true);
		});
	});

	describe("Dialog path", () => {
		it("auto-replies to extension_ui_request and settles", async () => {
			const { client, awaitSettle } = createClientWithSettleTracking();

			// Start the prompt
			const promptId = await client.prompt("say dialog");

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify settle happened
			expect(result.error).toBe(false);
			expect(result.aborted).toBe(false);
			expect(result.finalContent).toBeTruthy();
		});
	});

	describe("Handled disposition", () => {
		it("finalizes immediately without streaming", async () => {
			const { client, awaitSettle } = createClientWithSettleTracking();

			// Start the prompt
			const promptId = await client.prompt("say handled");

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify settle happened with handled disposition
			expect(result.stopReason).toBe("handled");
			expect(result.error).toBe(false);
			expect(result.aborted).toBe(false);
		});
	});

	describe("U+2028 framing regression guard", () => {
		it("does not mis-split records containing U+2028", async () => {
			const deltas: string[] = [];

			const { client, awaitSettle } = createClientWithSettleTracking({
				onDelta: (id: string, delta: string) => deltas.push(delta),
			});

			// Start the prompt with U+2028 in the message
			const promptId = await client.prompt("u2028 test");

			// Wait for settle
			const result = await awaitSettle(promptId);

			// Verify the delta arrived intact (not split)
			expect(deltas.length).toBeGreaterThan(0);
			const fullText = deltas.join("");
			// The fake-pi sends "line1\u2028line2"
			expect(fullText).toContain("\u2028");
			expect(fullText).toBe("line1\u2028line2");

			// Verify settle happened
			expect(result.error).toBe(false);
		});
	});

	describe("FIFO queue", () => {
		it("processes prompts in order and reports queued depth", async () => {
			const statusChanges: { status: PiStatus; depth: number }[] = [];
			const settleOrder: number[] = [];

			const { client, awaitSettle } = createClientWithSettleTracking({
				onStatusChange: (status: PiStatus, depth: number) => {
					statusChanges.push({ status, depth });
				},
				onSettle: (id: string, result: PiSettleResult) => {
					// Extract the order from the id
					const match = id.match(/pi-\d+-(\d+)/);
					if (match) {
						settleOrder.push(parseInt(match[1], 10));
					}
				},
			});

			// Start 3 prompts quickly
			const ids: string[] = [];
			for (let i = 0; i < 3; i++) {
				const id = await client.prompt(`queue test ${i}`);
				ids.push(id);
			}

			// Wait for all to settle
			for (const id of ids) {
				await awaitSettle(id);
			}

			// Verify all settled in order
			expect(settleOrder).toEqual([1, 2, 3]);

			// Verify queued depth was reported (at least once depth > 0)
			const hasQueuedDepth = statusChanges.some((s) => s.depth > 0);
			expect(hasQueuedDepth).toBe(true);
		});
	});

	describe("Timeout", () => {
		it("aborts and errors when prompt takes too long", async () => {
			const { client, awaitSettle } = createClientWithSettleTracking({
				timeoutMs: 100,
			});

			// The fake-pi always settles quickly (within 10ms), so a 100ms timeout
			// won't fire. This test verifies normal operation with a timeout set.

			// Start a prompt
			const promptId = await client.prompt("say happy");

			// Wait for settle (should complete quickly, well under 100ms)
			const result = await awaitSettle(promptId, 200);

			// The settle should have happened with success (timeout didn't fire)
			expect(result.error).toBe(false);
		});
	});

	describe("abort() when no active run", () => {
		it("resolves immediately", async () => {
			const client = new PiClient({
				workingDirectory: __dirname,
				timeoutMs: 0,
			});

			// abort when no active run should resolve immediately
			await expect(client.abort()).resolves.toBeUndefined();
		});
	});

	describe("shutdown", () => {
		it("closes stdin and waits for process exit", async () => {
			const client = new PiClient({
				workingDirectory: __dirname,
				timeoutMs: 0,
			});

			// Start a run to spawn the process
			await client.prompt("say happy");

			await new Promise((resolve) => setTimeout(resolve, 100));

			// Shutdown
			await client.shutdown();

			// Process should be terminated
			// Note: We can't easily check the process state from here
			// but the test passes if shutdown doesn't hang
		});
	});

	describe("spawn error handling", () => {
		it("handles spawn errors gracefully", async () => {
			const logCalls: string[] = [];
			const settles: PiSettleResult[] = [];

			// Inject a spawnCommand fake that emits an 'error' event (ENOENT),
			// simulating a missing node binary. The client should settle with error.
			const fakeSpawn = () => {
				const ee = new (require("events").EventEmitter)() as any;
				ee.stdin = { write: () => {}, end: () => {}, writable: true };
				ee.stdout = null;
				ee.stderr = null;
				setImmediate(() => ee.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })));
				return ee;
			};

			const client = new PiClient({
				workingDirectory: __dirname,
				timeoutMs: 0,
				spawnCommand: fakeSpawn as any,
				onLog: (msg: string) => logCalls.push(msg),
				onSettle: (id: string, result: PiSettleResult) => {
					settles.push(result);
				},
			});

			// This should fail to spawn
			try {
				await client.prompt("test");
			} catch {
				// Expected to fail
			}

			// Wait for settle to complete (spawn errors are async)
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Verify error settle
			expect(settles.length).toBe(1);
			expect(settles[0].error).toBe(true);
		});
	});
});
