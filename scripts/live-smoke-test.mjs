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
 * - Verifies at least one text_delta event arrives (streaming works)
 * - FAILS LOUDLY if pi's model errors (e.g. 429 rate limit)
 * - Does NOT pass on empty settle events
 * 
 * NOTE: This test requires a working pi model. If it fails with 429 error,
 *       it means the model service is unavailable - not a code issue.
 *       Unit tests against fake-pi are the real P2 coverage.
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
let stopReason = undefined;
let errorMessage = undefined;

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
			
			// Check for error in message_end content (pi embeds error info in message)
			if (msg.type === "message_end" && msg.message && msg.message.stopReason === "error") {
				stopReason = "error";
				errorMessage = msg.message.errorMessage;
				console.error(`[SMOKE] Model error: ${errorMessage || "Unknown error"}`);
			}
			
			if (msg.type === "agent_settled") {
				hasSettled = true;
				// Override with top-level fields if present
				if (msg.stopReason) stopReason = msg.stopReason;
				if (msg.errorMessage) errorMessage = msg.errorMessage;
				console.log(`[SMOKE] Settled: stopReason=${stopReason}, aborted=${msg.aborted}`);
			}
		} catch (err) {
			// Parse error - just log and continue
		}
	}
});

child.stderr.on("data", (chunk) => {
	// Ignore stderr (just pi's noise)
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
		
		// Fail if model returned an error (429, etc.)
		if (stopReason === "error") {
			console.error("\n==========================================");
			console.error("LIVE SMOKE TEST FAILED");
			console.error("==========================================");
			console.error("pi's default model returned an error.");
			if (errorMessage) {
				console.error(`Error message: ${errorMessage}`);
			}
			console.error("");
			console.error("This is NOT a code bug - it's a model/service issue.");
			console.error("Unit tests against fake-pi are the real P2 coverage.");
			console.error("Re-run this when:");
			console.error("- OpenCode Go credits reset, OR");
			console.error("- pi's default model is switched to an OpenRouter model");
			console.error("==========================================\n");
			process.exit(1);
		}
		
		// Require text_delta to verify streaming actually works
		if (!hasTextDelta) {
			console.error("\n==========================================");
			console.error("LIVE SMOKE TEST FAILED");
			console.error("==========================================");
			console.error("Expected: at least one text_delta event");
			console.error("Result: No text_delta received");
			console.error("This suggests streaming is broken or the model returned no content.");
			console.error("==========================================\n");
			process.exit(1);
		}
		
		console.log("[SMOKE] SUCCESS: Smoke test completed");
		console.log(`[SMOKE] - Text delta received: ${hasTextDelta}`);
		console.log(`[SMOKE] - Settled with stopReason: ${stopReason}`);
		process.exit(0);
	} else {
		// Check again in 100ms
		setTimeout(checkComplete, 100);
	}
};

// Start checking for completion
checkComplete();
