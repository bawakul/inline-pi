import * as fs from "fs";
import * as path from "path";

// Cached log path and flag
let logPath: string | null = null;
let initialized = false;
let enabled = true; // Default ON

/**
 * Enable or disable the debug log. When disabled, all calls to debugLog
 * become no-ops (fast path check).

/**
 * Enable or disable the debug log. When disabled, all calls to debugLog
 * become no-ops (fast path check).
 * @param enable True to enable, false to disable (fast path)
 */
export function setDebugLogEnabled(enable: boolean): void {
	enabled = enable;
}

/**
 * Resolve the log file path at ~/.pi/inline-pi-debug.log
 */
function getLogPath(): string {
	if (!logPath) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		logPath = path.join(home, ".pi", "inline-pi-debug.log");
	}
	return logPath;
}

/**
 * Append a timestamped line to the debug log file.
 * Best-effort: wraps in try/catch, never throws (logging must not break the plugin).
 * @param line The line to append (without timestamp)
 */
export function debugLog(line: string): void {
	// Fast path: if disabled, skip all work
	if (!enabled || line === "") return;

	try {
		// Lazy initialization of the log path
		if (!initialized) {
			getLogPath();
			initialized = true;
		}

		const logLine = `${new Date().toISOString()} ${line}\n`;
		const filePath = getLogPath();

		// Append to file (no truncation, just append)
		fs.appendFile(filePath, logLine, (err) => {
			// Best-effort: ignore errors silently
			// In practice, this could log to console.error if we wanted,
			// but the goal is to never break the plugin
			void err;
		});
	} catch {
		// Best-effort: ignore all errors silently
	}
}
