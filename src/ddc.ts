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

/** Learns which display index a model match refers to, caching the answer. */
async function resolveIndex(match: string, code: string): Promise<number> {
	const hit = resolved.get(match);
	if (hit !== undefined) {
		return hit.index;
	}
	const reply = await invoke(["get", "--match", match, "--code", code], RESOLVE_TIMEOUT_MS);
	const index = reply.index ?? 0;
	resolved.set(match, { index, monitors: monitorCount(reply) });
	return index;
}

export type VcpChange = { changed: boolean; previous: number };

/**
 * Sets a VCP feature, typically input source (0x60).
 *
 * Reads the feature back first, for two reasons. SetVCPFeature returns success
 * even when the DDC channel is dead — a monitor already showing another input
 * will happily "accept" a command it never received — so a prior read is the
 * only way to know the monitor is actually reachable and report honestly. It
 * also makes a press that changes nothing free.
 *
 * Note the read cannot be done *after* the write: on a monitor that serves MCCS
 * only on its active input, switching away is exactly what takes DDC offline.
 */
export async function setVcp(target: DdcTarget): Promise<VcpChange> {
	const code = target.code?.trim() || "0x60";
	const match = target.match?.trim() ?? "";

	const attempt = async (index: number): Promise<VcpChange> => {
		const before = await invoke(["get", "--index", String(index), "--code", code], CALL_TIMEOUT_MS);
		if (before.current === target.value) {
			return { changed: false, previous: before.current };
		}
		await invoke(
			["set", "--index", String(index), "--code", code, "--value", String(target.value)],
			CALL_TIMEOUT_MS,
		);
		return { changed: true, previous: before.current ?? -1 };
	};

	if (match === "") {
		return attempt(target.index ?? 0);
	}

	try {
		return await attempt(await resolveIndex(match, code));
	} catch (err) {
		// A cached index can go stale when displays are replugged. Re-resolve once
		// before giving up, so the key heals itself instead of staying broken.
		if (!resolved.has(match)) {
			throw err;
		}
		resolved.delete(match);
		return attempt(await resolveIndex(match, code));
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

/** An option for a property-inspector dropdown. */
export type PiItem = { label: string; value: string; disabled?: boolean };

/** MCCS 0x60 input-source values. 0x1B is the common vendor code for USB-C. */
const INPUT_NAMES = new Map<number, string>([
	[0x01, "VGA 1"],
	[0x02, "VGA 2"],
	[0x03, "DVI 1"],
	[0x04, "DVI 2"],
	[0x0c, "Component 1"],
	[0x0f, "DisplayPort 1"],
	[0x10, "DisplayPort 2 / mDP"],
	[0x11, "HDMI 1"],
	[0x12, "HDMI 2"],
	[0x1b, "USB-C / DP alt"],
]);

type RawMonitor = { index?: number; capabilities?: string | null };

function model(caps: string): string | null {
	return /model\(([^)]+)\)/.exec(caps)?.[1] ?? null;
}

/** The values a monitor lists for VCP 0x60, from its own capability string. */
function supportedInputs(caps: string): number[] {
	// e.g. "... 60( 0F 10 11 12) AA(01 02 04) ..."
	const block = /[^0-9A-Fa-f]60\(([^)]*)\)/.exec(caps)?.[1];
	if (block === undefined) {
		return [];
	}
	return block
		.trim()
		.split(/\s+/)
		.map((hex) => Number.parseInt(hex, 16))
		.filter((n) => Number.isFinite(n));
}

/**
 * Monitors that can actually be driven, for the property inspector.
 *
 * Only DDC-capable ones are listed: a monitor with no capability string cannot
 * be matched or commanded, so offering it would just build a key that fails.
 */
export async function monitorChoices(): Promise<PiItem[]> {
	// An explicit "off" entry first, so the list does not open already showing a
	// monitor. A single-item dropdown displays that item without firing a change
	// event, so nothing is ever written to settings and the key silently skips
	// the step while looking fully configured. Making the safe choice the one on
	// display means picking a monitor is a real change, and really persists.
	const items: PiItem[] = [{ label: "— don't switch a monitor —", value: "" }];
	for (const raw of (await listMonitors()) as RawMonitor[]) {
		const caps = raw.capabilities;
		if (typeof caps !== "string") {
			continue;
		}
		const name = model(caps);
		if (name !== null) {
			items.push({ label: name, value: name });
		}
	}
	if (items.length === 1) {
		items.push({
			label: "No DDC/CI monitor found — is it on another input?",
			value: "__none__",
			disabled: true,
		});
	}
	return items;
}

/**
 * Input sources to offer. Filtered to what the monitor reports it accepts, so a
 * key cannot be pointed at an input that does not exist. Falls back to the full
 * standard list when no monitor is reachable, so the key stays configurable.
 */
export async function inputChoices(): Promise<PiItem[]> {
	const label = (code: number): string =>
		`${INPUT_NAMES.get(code) ?? `Input 0x${code.toString(16).toUpperCase()}`} (0x${code
			.toString(16)
			.toUpperCase()
			.padStart(2, "0")})`;

	const unset: PiItem = { label: "— choose an input —", value: "" };
	try {
		for (const raw of (await listMonitors()) as RawMonitor[]) {
			const caps = raw.capabilities;
			if (typeof caps !== "string") {
				continue;
			}
			const codes = supportedInputs(caps);
			if (codes.length > 0) {
				return [unset, ...codes.map((code) => ({ label: label(code), value: String(code) }))];
			}
		}
	} catch {
		// Fall through to the standard list rather than leaving the field empty.
	}
	return [unset, ...[...INPUT_NAMES.keys()].map((code) => ({ label: label(code), value: String(code) }))];
}
