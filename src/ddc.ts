import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * DDC/CI monitor control.
 *
 * The helper is a small C# console app (scripts/DdcCtl.cs) compiled on first
 * use with the csc.exe that ships with the .NET Framework on every Windows
 * install. That avoids a native Node addon, whose ABI would have to match
 * whichever Node the Stream Deck app bundles.
 */

/** csc.exe has lived here since .NET Framework 4; present on all supported Windows. */
const CSC = join(
	process.env.WINDIR ?? "C:\Windows",
	"Microsoft.NET",
	"Framework64",
	"v4.0.30319",
	"csc.exe",
);

const COMPILE_TIMEOUT_MS = 30_000;
/** A get/set is ~95ms, but a monitor waking from sleep can take much longer. */
const CALL_TIMEOUT_MS = 10_000;
/** Resolving by model reads capability strings over I2C: ~1450ms. */
const RESOLVE_TIMEOUT_MS = 20_000;

export type DdcTarget = {
	/** Substring of the monitor's capability string, e.g. "U2414H". Preferred. */
	match?: string;
	/** Positional fallback when no match is given. */
	index?: number;
	/** VCP feature code; 0x60 is input source. */
	code?: string;
	value: number;
};

export class DdcError extends Error {}

type Reply = {
	ok: boolean;
	error?: string;
	monitors?: number | unknown[];
	index?: number;
	current?: number;
	max?: number;
};

function sourcePath(): string {
	// bin/plugin.js -> ../scripts/DdcCtl.cs, with cwd as a fallback because the
	// Stream Deck host's working directory is not contractually the plugin root.
	const candidates = [
		join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "DdcCtl.cs"),
		join(process.cwd(), "scripts", "DdcCtl.cs"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	throw new DdcError(`Could not find DdcCtl.cs (looked in ${candidates.join(", ")})`);
}

/** Cache dir that survives plugin updates, so the compile happens once ever. */
function cacheDir(): string {
	const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
	const dir = existsSync(base) ? join(base, "com.dgshue.mtviki") : join(tmpdir(), "com.dgshue.mtviki");
	mkdirSync(dir, { recursive: true });
	return dir;
}

let compiled: Promise<string> | null = null;

/** Compiles the helper if needed and returns the exe path. Keyed by source hash. */
function helperExe(): Promise<string> {
	if (compiled !== null) {
		return compiled;
	}
	compiled = (async () => {
		const source = sourcePath();
		// Hashing the source means an edited helper recompiles instead of the
		// stale exe silently winning.
		const hash = createHash("sha256").update(readFileSync(source)).digest("hex").slice(0, 12);
		const exe = join(cacheDir(), `ddcctl-${hash}.exe`);
		if (existsSync(exe)) {
			return exe;
		}
		if (!existsSync(CSC)) {
			throw new DdcError(`No C# compiler at ${CSC}; cannot build the DDC helper`);
		}
		await run(CSC, ["/nologo", "/target:exe", "/platform:x64", "/optimize+", `/out:${exe}`, source], {
			timeout: COMPILE_TIMEOUT_MS,
			windowsHide: true,
		});
		return exe;
	})().catch((err) => {
		compiled = null; // Let a later press retry rather than failing forever.
		throw err;
	});
	return compiled;
}

async function invoke(args: string[], timeout: number): Promise<Reply> {
	const exe = await helperExe();
	let stdout: string;
	try {
		({ stdout } = await run(exe, args, { timeout, windowsHide: true }));
	} catch (err) {
		// A non-zero exit still prints JSON on stdout; prefer that to the raw error.
		const out = (err as { stdout?: string }).stdout;
		if (typeof out === "string" && out.trim().length > 0) {
			stdout = out;
		} else {
			throw new DdcError((err as Error).message);
		}
	}

	let reply: Reply;
	try {
		reply = JSON.parse(stdout.trim()) as Reply;
	} catch {
		throw new DdcError(`Unparseable helper output: ${stdout.slice(0, 120)}`);
	}
	if (!reply.ok) {
		throw new DdcError(reply.error ?? "DDC call failed");
	}
	return reply;
}

/** Full monitor inventory, including capability strings. Slow; for setup only. */
export async function listMonitors(): Promise<unknown[]> {
	const reply = await invoke(["list"], RESOLVE_TIMEOUT_MS);
	return Array.isArray(reply.monitors) ? reply.monitors : [];
}

/**
 * Resolved index per match string, so only the first press pays the ~1450ms
 * capability read. Keyed with the monitor count: if a display is plugged or
 * unplugged the order can shift, and a stale index would quietly drive the
 * wrong panel.
 */
const resolved = new Map<string, { index: number; monitors: number }>();

function monitorCount(reply: Reply): number {
	return typeof reply.monitors === "number" ? reply.monitors : 0;
}

/**
 * Sets a VCP feature, typically input source (0x60).
 *
 * Resolves the monitor by model on the first call, then reuses the index. If
 * the fast path fails, or the display count has changed, it re-resolves once
 * and retries rather than leaving the key permanently broken.
 */
export async function setVcp(target: DdcTarget): Promise<void> {
	const code = target.code?.trim() || "0x60";
	const value = String(target.value);
	const match = target.match?.trim() ?? "";

	if (match === "") {
		await invoke(
			["set", "--index", String(target.index ?? 0), "--code", code, "--value", value],
			CALL_TIMEOUT_MS,
		);
		return;
	}

	const hit = resolved.get(match);
	if (hit !== undefined) {
		try {
			const reply = await invoke(
				["set", "--index", String(hit.index), "--code", code, "--value", value],
				CALL_TIMEOUT_MS,
			);
			if (monitorCount(reply) === hit.monitors) {
				return;
			}
			// Display count moved: that set may have hit the wrong panel, so fall
			// through and re-resolve before trusting the index again.
			resolved.delete(match);
		} catch {
			resolved.delete(match);
		}
	}

	const reply = await invoke(
		["set", "--match", match, "--code", code, "--value", value],
		RESOLVE_TIMEOUT_MS,
	);
	if (typeof reply.index === "number") {
		resolved.set(match, { index: reply.index, monitors: monitorCount(reply) });
	}
}

/** Reads a VCP feature. Used by the property inspector and for diagnostics. */
export async function getVcp(target: Omit<DdcTarget, "value">): Promise<{ current: number; max: number }> {
	const code = target.code?.trim() || "0x60";
	const match = target.match?.trim() ?? "";
	const args = match !== ""
		? ["get", "--match", match, "--code", code]
		: ["get", "--index", String(target.index ?? 0), "--code", code];
	const reply = await invoke(args, match !== "" ? RESOLVE_TIMEOUT_MS : CALL_TIMEOUT_MS);
	return { current: reply.current ?? 0, max: reply.max ?? 0 };
}
