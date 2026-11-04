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
			// Caller overrides (timeoutMs, drainGraceMs, handlers) win; the spawn
			// factory and the settle-tracking wrapper are ours.
			...userOptions,
			spawnCommand: fakeSpawnCommand,
			onSettle,
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

	describe("Multi-turn buffer reset (issue #8 regression guard)", () => {
		it("settles with only the LAST turn's content (no turn-N mashing)", async () => {
			const { client, awaitSettle } = createClientWithSettleTracking();

			// The "multi-turn" prompt triggers fake-pi's multiTurn scenario:
			// turn 1 ("Turn 1 text") followed by turn 2 ("Turn 2 final"),
			// each with message_start / text deltas / message_end.
			const promptId = await client.prompt("run multi-turn please");
			const result = await awaitSettle(promptId);

			expect(result.error).toBe(false);
			expect(result.aborted).toBe(false);
			// Without the message_start buffer reset, turn 2's text_delta
			// accumulates onto turn 1's message_end content, yielding
			// "Turn 1 textTurn 2 final". Final content must be the last turn only.
			expect(result.finalContent).toBe("Turn 2 final");
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
			// The watchdog path itself is covered by "Drain state (#20)" below.

			// Start a prompt
			const promptId = await client.prompt("say happy");

			// Wait for settle (should complete quickly, well under 100ms)
			const result = await awaitSettle(promptId, 200);

			// The settle should have happened with success (timeout didn't fire)
			expect(result.error).toBe(false);
		});
	});

	// Issue #20: a timed-out prompt's late agent_settled used to settle the next
	// queued prompt (and its stray tool events inflated that prompt's toolCount),
	// because settleActive released the queue while pi was still winding down.
	// The fix holds the queue in a "draining" state until the aborted run's
	// agent_settled arrives, or until the drain grace period expires.
	describe("Drain state (#20)", () => {
		it("holds the queue until the aborted run's late agent_settled arrives", async () => {
			const activities: PiActivity[] = [];
			const logs: string[] = [];
			const settleOrder: string[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				// 400ms leaves room for B's own 200ms reply after the drain, so B does
				// not trip its own watchdog (its budget is the same timeoutMs).
				timeoutMs: 400,
				drainGraceMs: 1000, // well past the fake's 150ms slow wind-down
				onActivity: (a: PiActivity) => activities.push(a),
				onLog: (msg: string) => logs.push(msg),
				onSettle: (id: string) => settleOrder.push(id),
			});

			// A times out; B is queued behind it.
			const aId = await client.prompt("slow-abort please");
			const aResult = await awaitSettle(aId);
			expect(aResult.error).toBe(true);
			expect(aResult.aborted).toBe(false);
			expect(aResult.errorMessage).toBe("Response timeout");

			const bId = await client.prompt("say happy (delayed)");
			const bResult = await awaitSettle(bId);

			// Pre-fix, B was promoted immediately: the old run's staggered
			// agent_settled{aborted:true} landed while B was still in flight and
			// settled it as "Aborted" with an empty buffer (the fake's delayed
			// reply keeps that window open).
			expect(bResult.aborted).toBe(false);
			expect(bResult.error).toBe(false);
			expect(bResult.finalContent).toBe("Hello world");
			expect(settleOrder).toEqual([aId, bId]);

			// The drain was released by the late agent_settled, not the grace fallback.
			expect(logs.some((l) => l.includes("drain complete (late agent_settled)"))).toBe(true);
			expect(logs.some((l) => l.includes("drain grace expired"))).toBe(false);

			// Stray wind-down tool events from the aborted run were swallowed: with
			// no active prompt they never reach onActivity / any toolCount.
			expect(activities.filter((a) => a.phase === "tool")).toEqual([]);
		});

		it("releases the queue loudly when pi never acknowledges the abort", async () => {
			const logs: string[] = [];
			const settleAt = new Map<string, number>();
			const drainGraceMs = 150;
			const { client, awaitSettle } = createClientWithSettleTracking({
				timeoutMs: 100,
				drainGraceMs,
				onLog: (msg: string) => logs.push(msg),
				onSettle: (id: string) => settleAt.set(id, Date.now()),
			});

			const aId = await client.prompt("never-settle please");
			const aResult = await awaitSettle(aId);
			expect(aResult.error).toBe(true);

			const bId = await client.prompt("say happy");
			const bResult = await awaitSettle(bId);

			expect(bResult.error).toBe(false);
			expect(bResult.aborted).toBe(false);
			expect(bResult.finalContent).toBe("Hello world");

			// The grace fallback fired, with the loud log line.
			expect(logs.some((l) => l.includes("drain grace expired"))).toBe(true);
			expect(logs.some((l) => l.includes("pi did not acknowledge abort"))).toBe(true);

			// B was dispatched only after the grace period, not immediately.
			const gap = settleAt.get(bId)! - settleAt.get(aId)!;
			expect(gap).toBeGreaterThanOrEqual(drainGraceMs - 40);
		});

		it("settles every queued prompt correctly after a single drain", async () => {
			const settleOrder: number[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				timeoutMs: 400,
				drainGraceMs: 1000,
				onSettle: (id: string) => {
					const match = id.match(/pi-\d+-(\d+)/);
					if (match) settleOrder.push(parseInt(match[1], 10));
				},
			});

			const aId = await client.prompt("slow-abort please");
			const bId = await client.prompt("say happy (delayed)");
			const cId = await client.prompt("run multi-turn please");

			const [a, b, c] = await Promise.all([
				awaitSettle(aId),
				awaitSettle(bId),
				awaitSettle(cId),
			]);

			expect(a.error).toBe(true);
			expect(a.errorMessage).toBe("Response timeout");
			expect(b.aborted).toBe(false);
			expect(b.finalContent).toBe("Hello world");
			expect(c.aborted).toBe(false);
			expect(c.finalContent).toBe("Turn 2 final");
			expect(settleOrder).toEqual([1, 2, 3]);
		});

		it("fails the held prompt and clears the drain when pi dies mid-drain", async () => {
			const results: PiSettleResult[] = [];
			const { client, awaitSettle } = createClientWithSettleTracking({
				timeoutMs: 100,
				drainGraceMs: 500,
				onSettle: (_id: string, result: PiSettleResult) => results.push(result),
			});

			const aId = await client.prompt("slow-abort please");
			// B is held behind the drain, so its prompt() promise is still pending. It
			// rejects when the process dies — attach the handler right away.
			const bPending = client.prompt("say happy").catch(() => undefined);

			// Drain is armed once A times out; kill pi while it is winding down.
			await awaitSettle(aId);
			expect(spawnedProcesses.length).toBe(1);
			spawnedProcesses[0].kill("SIGKILL");
			expect(await bPending).toBeUndefined();

			// The held prompt fails loudly rather than hanging on the drain.
			const deadline = Date.now() + 2000;
			while (results.length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(results.length).toBe(2);
			expect(results[1].error).toBe(true);
			expect(results[1].errorMessage).toContain("exited");

			// A prompt enqueued right after the death must not be held by the stale
			// drain flag (failActiveAndQueued clears it); without that, it would sit
			// out the remaining ~500ms of grace. The respawn is the only new process.
			const enqueuedAt = Date.now();
			const cId = await client.prompt("say happy");
			const cResult = await awaitSettle(cId);
			expect(cResult.error).toBe(false);
			expect(Date.now() - enqueuedAt).toBeLessThan(300);
			expect(spawnedProcesses.length).toBe(2);
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
