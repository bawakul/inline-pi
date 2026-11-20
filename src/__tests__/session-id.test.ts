import { describe, it, expect, afterEach, vi } from "vitest";
import {
	SESSION_ID_PATTERN,
	generateSessionId,
	isValidSessionId,
	slugifyVaultName,
} from "../session-id";

describe("session-id (issue #42)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("isValidSessionId", () => {
		it("accepts pi's session-id grammar", () => {
			for (const id of [
				"a",
				"A1",
				"inline-pi-bawa-s-lab-9f3k2q",
				"a.b_c-d",
				"0abc",
			]) {
				expect(isValidSessionId(id)).toBe(true);
			}
		});

		it("rejects ids pi would exit(1) on", () => {
			for (const id of ["", "-leading", "trailing-", ".dot", "has space", "sla/sh"]) {
				expect(isValidSessionId(id)).toBe(false);
			}
			expect(isValidSessionId(undefined)).toBe(false);
		});

		it("matches the documented pattern", () => {
			expect(SESSION_ID_PATTERN.source).toBe("^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$");
		});
	});

	describe("slugifyVaultName", () => {
		it("lowercases and collapses non-alphanumerics to single dashes", () => {
			expect(slugifyVaultName("Bawa's Lab")).toBe("bawa-s-lab");
			expect(slugifyVaultName("My  Vault!!")).toBe("my-vault");
			expect(slugifyVaultName("--Edge--")).toBe("edge");
		});

		it("falls back to 'vault' when nothing ASCII-alphanumeric survives", () => {
			expect(slugifyVaultName("日本語")).toBe("vault");
			expect(slugifyVaultName("")).toBe("vault");
		});
	});

	describe("generateSessionId", () => {
		it("produces a valid, prefixed, vault-scoped id", () => {
			const id = generateSessionId("Bawa's Lab");
			expect(isValidSessionId(id)).toBe(true);
			expect(id).toMatch(/^inline-pi-bawa-s-lab-[a-z0-9]{6}$/);
		});

		it("always satisfies pi's regex, whatever the vault name", () => {
			for (const name of ["", "日本語", "a".repeat(200), "!!!", "Vault 1"]) {
				expect(isValidSessionId(generateSessionId(name))).toBe(true);
			}
		});

		it("regenerates to a distinct id (fresh-thread requirement)", () => {
			vi.spyOn(Math, "random").mockReturnValueOnce(0.123456).mockReturnValueOnce(0.987654);
			const first = generateSessionId("Bawa's Lab");
			const second = generateSessionId("Bawa's Lab");
			expect(first).not.toBe(second);
			expect(first).toMatch(/^inline-pi-bawa-s-lab-/);
			expect(second).toMatch(/^inline-pi-bawa-s-lab-/);
		});

		it("pads a short base36 slice to six characters", () => {
			vi.spyOn(Math, "random").mockReturnValueOnce(0.5);
			// (0.5).toString(36) === "0.i" -> slice(2, 8) === "i"
			expect(generateSessionId("V")).toMatch(/-[a-z0-9]{6}$/);
		});
	});
});
