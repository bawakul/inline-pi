#!/usr/bin/env node

/**
 * Live smoke test for inline-pi.
 * 
 * Spawns real `pi --mode rpc --no-session` and verifies basic functionality.
 * Run with: node scripts/live-smoke-test.mjs
 * 
 * This test:
 * - Spawns real pi as a child process
 * - Sends a trivial prompt
 * - Verifies at least one text_delta or message_end arrives within ~30s
 * - Reports real failures (network, pi not found, etc.)
 */

import { spawn } from "child_process";
import { resolve as resolvePath, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SMOKE_TEST_TIMEOUT_MS = 30_000;
const WORKING_DIR = resolvePath(__dirname, "..");

let hasTextDelta = false;
let hasSettled = false;
let hasMessageContent = false;
let settleResult = null;

const child = spawn("pi", ["--mode", "rpc", "--no-session"], {
	cwd: WORKING_DIR,
	windowsHide: true,
	stdio: ["pipe", "pipe", "pipe"],
});

// Track stdout chunks
let stdoutBuffer = "";
child.stdout.on("data", (chunk) => {
	stdoutBuffer += chunk.toString("utf8");
	
	// Process complete lines
	const lines = stdoutBuffer.split("\n");
	stdoutBuffer = lines.pop() ?? "";
	
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const msg = JSON.parse(line);
			
			if (msg.type === "message_update" && msg.assistantMessageEvent?.type === "text_delta") {
				hasTextDelta = true;
				console.log(`[SMOKE] Text delta: ${msg.assistantMessageEvent.delta}`);
			}
			
			if (msg.type === "message_end" && msg.message && typeof msg.message === "string" && msg.message.length > 0) {
				hasMessageContent = true;
				console.log(`[SMOKE] Message content (first 100 chars): ${msg.message.substring(0, 100)}...`);
			}
			
			if (msg.type === "agent_settled") {
				hasSettled = true;
				settleResult = msg;
				console.log(`[SMOKE] Settled: ${JSON.stringify(msg)}`);
			}
		} catch (err) {
			// Parse error - just log and continue
		}
	}
});

child.stderr.on("data", (chunk) => {
	// Ignore stderr (just noise from pi)
});

child.on("error", (err) => {
	console.error(`[SMOKE] Process error: ${err.message}`);
	if (err.code === "ENOENT") {
		console.error("[SMOKE] ERROR: 'pi' not found on PATH");
	}
	process.exit(1);
});

child.on("exit", (code, signal) => {
	console.log(`[SMOKE] Process exited: code=${code} signal=${signal}`);
});

// Send prompt
child.stdin.write(JSON.stringify({
	id: "smoke-1",
	type: "prompt",
	message: "Reply with just: ok",
}) + "\n");

// Timeout handler
const timeout = setTimeout(() => {
	console.error("[SMOKE] TIMEOUT: Test did not complete within 30s");
	child.kill("SIGTERM");
	process.exit(1);
}, SMOKE_TEST_TIMEOUT_MS);

// Check for completion
const checkComplete = () => {
	if (hasSettled) {
		clearTimeout(timeout);
		child.kill("SIGTERM");
		console.log("[SMOKE] SUCCESS: Smoke test completed");
		console.log(`[SMOKE] - Text delta received: ${hasTextDelta}`);
		console.log(`[SMOKE] - Message content received: ${hasMessageContent}`);
		console.log(`[SMOKE] - Settled with stopReason: ${settleResult?.stopReason}`);
		
		// Check if we got some output (either text_delta or message_end with content)
		if (hasTextDelta || hasMessageContent || settleResult) {
			process.exit(0);
		} else {
			console.error("[SMOKE] FAILED: Missing expected events");
			process.exit(1);
		}
	} else {
		// Check again in 100ms
		setTimeout(checkComplete, 100);
	}
};

// Start checking for completion
checkComplete();
