import { spawn, type ChildProcess, type SpawnOptions } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** Terminal classification delivered via onSettle. */
export interface PiSettleResult {
	/** Final assistant content (may be empty). */
	finalContent: string;
	/** True if the run was cancelled. */
	aborted: boolean;
	/** True if pi reported an error stopReason. */
	error: boolean;
	/** Human-readable error when error === true. */
	errorMessage?: string;
	/** Last reported stop reason (e.g. "stop", "toolUse", "error"). */
	stopReason?: string;
}

export type PiStatus = "dead" | "ready" | "busy";

export interface PiClientOptions {
	/** Directory used as pi's cwd. */
	workingDirectory: string;
	/** Prompt -> agent_settled watchdog in ms. 0 disables. */
	timeoutMs: number;
	/** Optional explicit pi executable; otherwise resolved from PATH. */
	piCommand?: string | null;
	/**
	 * Injectable spawn factory. Defaults to Node's child_process.spawn.
	 * Tests provide a fake-pi factory to exercise the real transport path.
	 */
	spawnCommand?: SpawnCommand;
	/** Status changes (dead/ready/busy). */
	onStatusChange?: (status: PiStatus, queuedDepth: number) => void;
	/** Streaming text delta for the currently active prompt id. */
	onDelta?: (id: string, delta: string) => void;
	/** Terminal result for a prompt id. */
	onSettle?: (id: string, result: PiSettleResult) => void;
	/** Unexpected child exit (or after shutdown). */
	onExit?: (code: number | null, signal: string | null) => void;
	/** Recoverable transport / parse diagnostics. */
	onLog?: (message: string) => void;
}

export type SpawnCommand = (
	command: string,
	args: readonly string[],
	options: SpawnOptions
) => ChildProcess;

interface PromptRequest {
	id: string;
	message: string;
	resolve: () => void;
	reject: (err: Error) => void;
	buffer: string;
	stopReason?: string;
	errorMessage?: string;
	timeoutHandle?: NodeJS.Timeout;
}

const DEFAULT_PI_TIMEOUT_MS = 300_000;
const PATH_PROBE_TIMEOUT_MS = 5_000;
const SHELL_PATH_SENTINEL_START = "__PI_PATH_S__";
const SHELL_PATH_SENTINEL_END = "__PI_PATH_E__";
const FALLBACK_PI_PATHS = [
	"/opt/homebrew/bin/pi",
	"/usr/local/bin/pi",
	path.join(os.homedir(), ".local", "bin", "pi"),
];

/** Cached result of the async PATH probe. */
let cachedPiPath: string | undefined;

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.promises.access(p, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function resolveLoginShellPath(): Promise<string | null> {
	const shell = process.env.SHELL || "/bin/zsh";
	const cmd = `echo "${SHELL_PATH_SENTINEL_START}$PATH${SHELL_PATH_SENTINEL_END}"`;
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const child = spawn(shell, ["-i", "-l", "-c", cmd], {
			windowsHide: true,
			env: process.env,
		});

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve(null);
		}, PATH_PROBE_TIMEOUT_MS);

		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});

		child.on("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(null);
		});

		child.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const pattern = new RegExp(
				`${SHELL_PATH_SENTINEL_START}([^]*)${SHELL_PATH_SENTINEL_END}`
			);
			const m = stdout.match(pattern);
			resolve(m?.[1]?.trim() || null);
		});
	});
}

function findPiInPath(pathEnv: string): string[] {
	return pathEnv
		.split(":")
		.map((dir) => path.join(dir.trim(), "pi"))
		.filter(Boolean);
}

/**
 * Resolve the `pi` executable path asynchronously.
 * Probes the user's login-shell PATH first (sentinel + timeout), then checks
 * fallbacks and a known-good shim location discovered at install time.
 * Never hardcodes the managed-install release directory.
 */
export async function resolvePiPath(): Promise<string> {
	if (cachedPiPath !== undefined) return cachedPiPath;

	const candidates: string[] = [];

	const shellPath = await resolveLoginShellPath();
	if (shellPath) {
		candidates.push(...findPiInPath(shellPath));
	}

	// Discovered shim location from `command -v pi` (Bawa's Lab install).
	// Kept as a fallback, not the sole source, so the probe stays meaningful.
	candidates.push(
		"/Users/bharadwajkulkarni/.local/bin/pi",
		...FALLBACK_PI_PATHS
	);

	for (const c of candidates) {
		if (await fileExists(c)) {
			cachedPiPath = c;
			return c;
		}
	}

	// Last resort: let the shell resolve it at spawn time.
	cachedPiPath = "pi";
	return cachedPiPath;
}

export class PiClient {
	private opts: Required<PiClientOptions>;
	private process: ChildProcess | null = null;
	private status: PiStatus = "dead";
	private queue: PromptRequest[] = [];
	private active: PromptRequest | null = null;
	private nextId = 1;
	private readBuffer = "";
	private shuttingDown = false;
	private piPath: string | null = null;

	constructor(opts: PiClientOptions) {
		this.opts = {
			workingDirectory: opts.workingDirectory,
			timeoutMs: opts.timeoutMs ?? DEFAULT_PI_TIMEOUT_MS,
			piCommand: opts.piCommand ?? null,
			spawnCommand: opts.spawnCommand ?? spawn,
			onStatusChange: opts.onStatusChange ?? (() => {}),
			onDelta: opts.onDelta ?? (() => {}),
			onSettle: opts.onSettle ?? (() => {}),
			onExit: opts.onExit ?? (() => {}),
			onLog: opts.onLog ?? (() => {}),
		} as Required<PiClientOptions>;
	}

	private log(msg: string): void {
		this.opts.onLog(`[pi-client] ${msg}`);
	}

	private setStatus(status: PiStatus): void {
		if (this.status === status) return;
		this.status = status;
		this.opts.onStatusChange(status, this.queue.length);
	}

	private nextPromptId(): string {
		return `pi-${Date.now()}-${this.nextId++}`;
	}

	/** Ensure the hidden pi process is running. */
	async ensureSpawned(): Promise<void> {
		if (this.process && this.process.exitCode === null) {
			return;
		}
		if (this.shuttingDown) {
			throw new Error("PiClient is shutting down");
		}
		return this.spawn();
	}

	private async spawn(): Promise<void> {
		this.setStatus("dead");
		if (this.piPath === null) {
			this.piPath = this.opts.piCommand ?? (await resolvePiPath());
		}

		const cmd = this.piPath;
		// --thinking off: ;; note Q&A is fast inline exchange, not extended reasoning.
		// glm-5.2 (and other reasoning models) otherwise emit long thinking_delta
		// streams before any text_delta, so the callout appears frozen while it thinks.
		const args = ["--mode", "rpc", "--no-session", "--thinking", "off"];
		const env = {
			...process.env,
			// Inherit the resolved PATH so the shim can find its managed node, etc.
			PATH: process.env.PATH ?? "",
		};

		this.log(`spawning: ${cmd} ${args.join(" ")} cwd=${this.opts.workingDirectory}`);

		return new Promise((resolve, reject) => {
			let resolved = false;
			const proc = this.opts.spawnCommand(cmd, args, {
				cwd: this.opts.workingDirectory,
				env,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});

			this.process = proc;

			proc.on("error", (err) => {
				this.log(`spawn error: ${err.message}`);
				this.setStatus("dead");
				if (!resolved) {
					resolved = true;
					reject(err);
				} else {
					this.failActiveAndQueued(new Error(`pi process error: ${err.message}`));
				}
			});

			proc.on("exit", (code, signal) => {
				this.log(`process exited code=${code} signal=${signal}`);
				this.process = null;
				this.setStatus("dead");
				this.failActiveAndQueued(new Error("pi process exited unexpectedly"));
				this.opts.onExit(code, signal);
			});

			proc.stderr?.on("data", (chunk) => {
				const text = chunk.toString("utf8").trimEnd();
				if (text) this.log(`stderr: ${text}`);
			});

			proc.stdout?.on("data", (chunk) => this.handleStdoutChunk(chunk));

			// Give the process a tick to fail (ENOENT, etc.) before reporting ready.
			setImmediate(() => {
				if (!resolved) {
					resolved = true;
					if (proc.exitCode !== null || proc.signalCode !== null) {
						reject(new Error("pi process failed immediately after spawn"));
					} else {
						this.setStatus(this.active ? "busy" : "ready");
						resolve();
					}
				}
			});
		});
	}

	private handleStdoutChunk(chunk: Buffer): void {
		this.readBuffer += chunk.toString("utf8");
		// Strict LF split — never readline, which splits on U+2028/U+2029.
		const lines = this.readBuffer.split("\n");
		this.readBuffer = lines.pop() ?? "";
		for (const line of lines) {
			if (line.length === 0) continue;
			this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let msg: any;
		try {
			msg = JSON.parse(line);
		} catch (err) {
			this.log(`malformed JSON on stdout (${line.length} chars): ${(err as Error).message}`);
			return;
		}

		// pi's id-less parse-error response has no id.
		if (msg.command === "parse" && msg.error) {
			this.log(`pi parse error: ${msg.error}`);
			return;
		}

		const id = typeof msg.id === "string" ? msg.id : undefined;

		if (msg.type === "response" && id) {
			this.handleResponse(id, msg.data);
			return;
		}

		if (id && this.active && id !== this.active.id) {
			this.log(`ignoring event for stale id ${id}; active=${this.active.id}`);
			return;
		}

		switch (msg.type) {
			case "message_update": {
				const ev = msg.assistantMessageEvent;
				if (ev?.type === "text_delta" && typeof ev.delta === "string") {
					if (this.active) {
						this.active.buffer += ev.delta;
						this.opts.onDelta(this.active.id, ev.delta);
					}
				}
				break;
			}
			case "message_end": {
				if (this.active && typeof msg.message === "string") {
					this.active.buffer = msg.message;
				}
				if (msg.stopReason && this.active) {
					this.active.stopReason = msg.stopReason;
				}
				break;
			}
			case "agent_settled": {
				this.handleAgentSettled(msg);
				break;
			}
			case "agent_end": {
				if (msg.willRetry) {
					this.log("agent_end willRetry=true; waiting for agent_settled");
				}
				break;
			}
			case "auto_retry_start":
			case "auto_retry_end": {
				this.log(`auto_retry ${msg.type}${"success" in msg ? ` success=${msg.success}` : ""}`);
				break;
			}
			case "extension_ui_request": {
				this.handleExtensionUiRequest(msg);
				break;
			}
			// thinking_* events are liveness signals — the model is reasoning before text.
			// We don't render thinking content (the callout shows text_delta only), but surface
			// it via onLog so the plugin could show a "thinking…" state instead of a dead spin.
			case "thinking_start":
			case "thinking_delta": {
				if (this.active) this.opts.onLog(`thinking (${msg.assistantMessageEvent?.type})`);
				break;
			}
			case "queue_update":
			case "session_info_changed":
			case "thinking_level_changed":
			case "extension_error":
			case "compaction_started":
			case "compaction_finished": {
				this.log(`ignoring ${msg.type}`);
				break;
			}
			default: {
				// Unknown events are logged but not fatal.
				this.log(`unknown event type: ${msg.type}`);
			}
		}
	}

	private handleResponse(id: string, data: any): void {
		if (!this.active || this.active.id !== id) {
			this.log(`response for unexpected id ${id}`);
			return;
		}
		const disposition = data?.disposition;
		if (disposition === "started") {
			this.log(`prompt ${id} started`);
			this.active.resolve();
			this.setStatus("busy");
		} else if (disposition === "handled") {
			this.log(`prompt ${id} handled (no stream)`);
			this.active.resolve();
			// No run, no agent_settled — finalize immediately.
			this.settleActive({
				finalContent: this.active.buffer,
				aborted: false,
				error: false,
				stopReason: "handled",
			});
		} else if (disposition === "queued") {
			// Client-side FIFO means this should never happen; log and keep waiting.
			this.log(`unexpected queued disposition for ${id}`);
		} else {
			this.log(`unknown disposition ${disposition} for ${id}`);
		}
	}

	private handleAgentSettled(msg: any): void {
		if (!this.active) return;
		const aborted = msg.aborted === true;
		const stopReason = msg.stopReason ?? this.active.stopReason;
		const errorMessage = msg.errorMessage ?? this.active.errorMessage;

		if (aborted) {
			this.settleActive({
				finalContent: this.active.buffer,
				aborted: true,
				error: false,
				stopReason,
			});
		} else if (stopReason === "error") {
			this.settleActive({
				finalContent: this.active.buffer,
				aborted: false,
				error: true,
				errorMessage: errorMessage || "pi reported an error",
				stopReason,
			});
		} else {
			this.settleActive({
				finalContent: this.active.buffer,
				aborted: false,
				error: false,
				stopReason,
			});
		}
	}

	private handleExtensionUiRequest(msg: any): void {
		const reqId = msg.id;
		this.log(`auto-cancelling extension_ui_request id=${reqId}`);
		this.send({ type: "extension_ui_response", id: reqId, cancelled: true });
	}

	private settleActive(result: PiSettleResult): void {
		const req = this.active;
		if (!req) return;
		this.active = null;
		if (req.timeoutHandle) {
			clearTimeout(req.timeoutHandle);
			req.timeoutHandle = undefined;
		}
		this.opts.onSettle(req.id, result);
		this.dispatchNext();
	}

	private failActiveAndQueued(err: Error): void {
		if (this.active) {
			const req = this.active;
			this.active = null;
			if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
			req.reject(err);
			this.opts.onSettle(req.id, {
				finalContent: req.buffer,
				aborted: false,
				error: true,
				errorMessage: err.message,
			});
		}
		while (this.queue.length > 0) {
			const req = this.queue.shift()!;
			if (req.timeoutHandle) clearTimeout(req.timeoutHandle);
			req.reject(err);
			this.opts.onSettle(req.id, {
				finalContent: "",
				aborted: false,
				error: true,
				errorMessage: err.message,
			});
		}
		this.setStatus("dead");
	}

	private send(obj: unknown): void {
		const proc = this.process;
		if (!proc || proc.stdin?.writable === false) {
			this.log("cannot send: stdin closed");
			return;
		}
		const line = JSON.stringify(obj) + "\n";
		proc.stdin!.write(line, (err) => {
			if (err) this.log(`stdin write error: ${err.message}`);
		});
	}

	/**
	 * Enqueue a prompt. Resolves once the prompt is accepted by pi
	 * (disposition "started" or "handled"). Streaming deltas and the final
	 * settlement arrive via onDelta / onSettle callbacks.
	 */
	async prompt(message: string): Promise<string> {
		const id = this.nextPromptId();
		return new Promise((resolveOuter, rejectOuter) => {
			let settled = false;
			const req: PromptRequest = {
				id,
				message,
				resolve: () => {
					if (settled) return;
					settled = true;
					resolveOuter(id);
				},
				reject: (err) => {
					if (settled) return;
					settled = true;
					rejectOuter(err);
				},
				buffer: "",
			};
			this.queue.push(req);
			this.dispatchNext();
		});
	}

	private async dispatchNext(): Promise<void> {
		if (this.active || this.queue.length === 0) return;
		if (this.shuttingDown) {
			this.failActiveAndQueued(new Error("PiClient is shutting down"));
			return;
		}

		try {
			await this.ensureSpawned();
		} catch (err) {
			this.failActiveAndQueued(err as Error);
			return;
		}

		const req = this.queue.shift()!;
		this.active = req;
		this.setStatus("busy");

		if (this.opts.timeoutMs > 0) {
			req.timeoutHandle = setTimeout(() => {
				this.log(`prompt ${req.id} timed out after ${this.opts.timeoutMs}ms; aborting`);
				this.send({ type: "abort" });
				this.settleActive({
					finalContent: req.buffer,
					aborted: false,
					error: true,
					errorMessage: "Response timeout",
				});
			}, this.opts.timeoutMs);
		}

		this.send({ id: req.id, type: "prompt", message: req.message });
	}

	/** Cancel the active prompt. Resolves once the aborted settlement arrives. */
	async abort(): Promise<void> {
		if (!this.active) return;
		return new Promise((resolve, reject) => {
			const req = this.active;
			if (!req) {
				resolve();
				return;
			}
			const originalSettle = this.opts.onSettle;
			const once = (id: string, result: PiSettleResult) => {
				if (id !== req.id) return;
				this.opts.onSettle = originalSettle;
				if (result.aborted) {
					resolve();
				} else {
					reject(new Error("prompt settled without abort flag"));
				}
			};
			this.opts.onSettle = (id, result) => {
				originalSettle(id, result);
				once(id, result);
			};
			this.send({ type: "abort" });
		});
	}

	/** Close stdin for orderly shutdown and wait for process exit. */
	async shutdown(timeoutMs = 2_000): Promise<void> {
		this.shuttingDown = true;
		this.failActiveAndQueued(new Error("PiClient is shutting down"));

		const proc = this.process;
		if (!proc) return;

		return new Promise((resolve) => {
			let resolved = false;
			const finish = () => {
				if (resolved) return;
				resolved = true;
				resolve();
			};

			const timer = setTimeout(() => {
				this.log("shutdown grace expired; terminating pi");
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!resolved) {
						this.log("SIGTERM grace expired; killing pi");
						proc.kill("SIGKILL");
					}
					finish();
				}, 500);
			}, timeoutMs);

			proc.on("exit", () => {
				clearTimeout(timer);
				finish();
			});

			if (proc.stdin?.writable) {
				proc.stdin.end(() => {
					// stdin closed; wait for graceful exit above.
				});
			} else {
				proc.kill("SIGTERM");
			}
		});
	}
}
