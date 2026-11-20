/**
 * Stable pi session ids for resumable `;;` threads (issue #42).
 *
 * pi validates `--session-id` against this exact rule before spawning
 * (`assertValidSessionId` in pi's core/session-manager.ts) and calls
 * `process.exit(1)` on a mismatch — so we validate on our side too, both when
 * generating and when reading a hand-edited data.json.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** True when `id` is a session id pi will accept. */
export function isValidSessionId(id: string | undefined): id is string {
	if (!id) return false;
	return SESSION_ID_PATTERN.test(id);
}

/**
 * Lowercase, collapse every non-alphanumeric run to a single dash, trim dashes.
 * Returns "vault" when the name has no ASCII alphanumerics at all (non-Latin
 * vault names would otherwise slugify to an empty string).
 */
export function slugifyVaultName(vaultName: string): string {
	const slug = vaultName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "vault";
}

/**
 * Generate a fresh stable session id for a vault:
 * `inline-pi-<vault-slug>-<rand6>`. The id ends up in pi's session filename
 * (`<timestamp>_<id>.jsonl`) and the `pi --resume` picker, so the `inline-pi-`
 * prefix keeps plugin threads distinguishable from hand-run sessions in the
 * same (~/.pi/agent/sessions/…) directory.
 *
 * Regenerating is how "start fresh thread" sheds a stale thread: the old
 * session file stays on disk under the old id (recoverable with `pi --resume`).
 */
export function generateSessionId(vaultName: string): string {
	const slug = slugifyVaultName(vaultName);
	// base36 slice(2) is usually 10-11 chars; pad so a pathological short slice
	// (e.g. exactly 0.5 → "i") still satisfies the min-length id rule.
	const random = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
	const id = `inline-pi-${slug}-${random}`;
	// Defensive: any id must survive pi's regex (slug is already alnum + dashes).
	return isValidSessionId(id) ? id : `inline-pi-${random}`;
}
