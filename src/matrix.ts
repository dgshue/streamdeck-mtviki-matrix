/**
 * MT-VIKI HDMI matrix client.
 *
 * Protocol reverse-engineered from the unit's own web GUI (lighttpd on the
 * MediaTek LAN module, /js/comms.js). Every call is a POST to matrixs.cgi with
 * a form body of `matrixdata=<json>`, guarded by HTTP basic auth.
 *
 *   GETSWS                -> {"SWS":"1 2 3 4"}   input feeding out1..outN
 *   SW <in> <out> [out..] -> {"result":"1"}      route input to one or more outputs
 *   SWALL <in>            -> {"result":"1"}      input to every output
 *   SWOTO                 -> {"result":"1"}      identity map (1->1, 2->2, ...)
 *   SetOutput <out> <0|1> -> {"result":"1"}      disable/enable an output
 *   GETNVRAM FIELD:<key>  -> {"<key>":"<value>"} e.g. MatrixMaxIn / MatrixMaxOut
 */

export type MatrixConnection = {
	host: string;
	username: string;
	password: string;
};

export const DEFAULT_CONNECTION: MatrixConnection = {
	host: "192.168.2.200",
	username: "admin",
	password: "admin",
};

/**
 * After a switch the LAN module keeps answering GETSWS with the *previous*
 * routing for a while — measured at up to ~190ms on a 4x4, and the stock GUI
 * waits 500ms before re-reading for the same reason. Reading inside that window
 * yields a stale map, and a swap computed from a stale map moves the wrong
 * sources. So: never read until the window has passed, and in the meantime
 * trust the optimistic map we already know is correct.
 */
const SETTLE_MS = 500;

/**
 * How long an optimistic map stays authoritative. Must exceed SETTLE_MS so a
 * second key press inside the stale window uses our own map instead of forcing
 * a read that would have to block. Front-panel and IR changes are picked up by
 * the background poll.
 */
const CACHE_TTL_MS = 2500;
const REQUEST_TIMEOUT_MS = 4000;

export class MatrixError extends Error {}

type CacheEntry = { at: number; routes: number[] };

const routeCache = new Map<string, CacheEntry>();

/** Timestamp of the last write per host, used to enforce the settle window. */
const lastWriteAt = new Map<string, number>();

/** Serialises writes per host so two buttons pressed together cannot interleave. */
const writeQueues = new Map<string, Promise<unknown>>();

function key(conn: MatrixConnection): string {
	return `${conn.host}|${conn.username}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Blocks until the matrix has had time to make a recent write observable. */
async function awaitSettled(conn: MatrixConnection): Promise<void> {
	const wrote = lastWriteAt.get(key(conn));
	if (wrote === undefined) {
		return;
	}
	const remaining = SETTLE_MS - (Date.now() - wrote);
	if (remaining > 0) {
		await sleep(remaining);
	}
}

function endpoint(host: string): string {
	const bare = host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
	return `http://${bare}/cgi-bin/matrixs.cgi`;
}

async function send(
	conn: MatrixConnection,
	command: string,
	extra: Record<string, string> = {},
): Promise<Record<string, string>> {
	// The GUI posts the raw JSON unencoded (jQuery processData:false), and the
	// CGI parses it that way — url-encoding the body makes it reject the command.
	if (process.env.MTVIKI_TRACE) console.error(`  -> ${command}${extra.FIELD ? " " + extra.FIELD : ""}`);
	const body = `matrixdata=${JSON.stringify({ COMMAND: command, ...extra })}`;
	const auth = Buffer.from(`${conn.username}:${conn.password}`).toString("base64");

	let res: Response;
	try {
		res = await fetch(endpoint(conn.host), {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Authorization: `Basic ${auth}`,
			},
			body,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (err) {
		throw new MatrixError(`${conn.host} unreachable: ${(err as Error).message}`);
	}

	if (res.status === 401) {
		throw new MatrixError(`Authentication failed for ${conn.username}@${conn.host}`);
	}
	if (!res.ok) {
		throw new MatrixError(`${conn.host} returned HTTP ${res.status}`);
	}

	const text = await res.text();
	try {
		return JSON.parse(text) as Record<string, string>;
	} catch {
		throw new MatrixError(`Unparseable reply from ${conn.host}: ${text.slice(0, 80)}`);
	}
}

/** Runs `fn` after any in-flight write to the same host has settled. */
function enqueue<T>(conn: MatrixConnection, fn: () => Promise<T>): Promise<T> {
	const k = key(conn);
	const prior = writeQueues.get(k) ?? Promise.resolve();
	const next = prior.catch(() => {}).then(fn);
	writeQueues.set(k, next.catch(() => {}));
	return next;
}

/**
 * Current routing as a 1-based input number per output, indexed by output-1.
 * `[2, 1, 3, 4]` means output 1 shows input 2, output 2 shows input 1, and so on.
 */
export async function getRoutes(conn: MatrixConnection, maxAgeMs = CACHE_TTL_MS): Promise<number[]> {
	const k = key(conn);
	const hit = routeCache.get(k);
	if (hit && Date.now() - hit.at < maxAgeMs) {
		return hit.routes;
	}

	await awaitSettled(conn);

	const data = await send(conn, "GETSWS");
	const sws = data.SWS;
	if (typeof sws !== "string") {
		throw new MatrixError(`GETSWS returned no SWS field`);
	}

	const routes = sws.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
	if (routes.length === 0 || routes.some((n) => !Number.isFinite(n))) {
		throw new MatrixError(`GETSWS returned malformed routing "${sws}"`);
	}

	routeCache.set(k, { at: Date.now(), routes });
	return routes;
}

function invalidate(conn: MatrixConnection): void {
	routeCache.delete(key(conn));
}

async function assertOk(conn: MatrixConnection, command: string): Promise<void> {
	const data = await send(conn, command);
	lastWriteAt.set(key(conn), Date.now());
	if (data.result !== "1") {
		// The CGI acks before the matrix MCU acts, so a "1" is not proof of a
		// switch — but anything else is proof of a failure.
		throw new MatrixError(`Matrix rejected "${command}"`);
	}
}

/** Routes one input to one or more outputs (all 1-based). */
export function route(conn: MatrixConnection, input: number, outputs: number[]): Promise<void> {
	if (outputs.length === 0) {
		return Promise.resolve();
	}
	return enqueue(conn, async () => {
		await assertOk(conn, `SW ${input} ${outputs.join(" ")}`);
		invalidate(conn);
	});
}

/**
 * Restores the default one-to-one map: input 1 to output 1, 2 to 2, and so on.
 *
 * The matrix does this in a single SWOTO, so it lands as one clean switch
 * rather than N separate SW commands.
 */
export function resetIdentity(conn: MatrixConnection): Promise<number[]> {
	return enqueue(conn, async () => {
		const known = routeCache.get(key(conn))?.routes.length;
		await assertOk(conn, "SWOTO");

		if (known === undefined) {
			// Output count unknown, so there is no map to record optimistically.
			invalidate(conn);
			return [];
		}

		// SWOTO only restores routing, so a screen blanked by a layout would stay
		// dark. "Back to default" has to mean every screen is lit again too.
		await lightAllInline(conn, known);

		// The resulting map is exactly known, so record it instead of forcing a
		// read inside the settle window.
		const routes = Array.from({ length: known }, (_, i) => i + 1);
		routeCache.set(key(conn), { at: Date.now(), routes });
		return routes;
	});
}

/**
 * Exchanges the sources feeding two outputs and returns the resulting routing.
 *
 * There is no atomic swap in the protocol, so this reads the current map and
 * issues the two SW commands back to back. Both are queued together to keep a
 * second button press from reading a half-applied state.
 */
export function swapOutputs(conn: MatrixConnection, outA: number, outB: number): Promise<number[]> {
	return enqueue(conn, async () => {
		// Deliberately cache-friendly: right after our own write the device would
		// report a stale map, while our optimistic one is known good.
		const routes = await getRoutes(conn);

		for (const out of [outA, outB]) {
			if (out < 1 || out > routes.length) {
				throw new MatrixError(`Output ${out} is out of range (matrix has ${routes.length})`);
			}
		}

		const inA = routes[outA - 1]!;
		const inB = routes[outB - 1]!;
		if (inA === inB) {
			return routes; // Both outputs already show the same source; nothing to do.
		}

		await assertOk(conn, `SW ${inB} ${outA}`);
		await assertOk(conn, `SW ${inA} ${outB}`);

		const updated = [...routes];
		updated[outA - 1] = inB;
		updated[outB - 1] = inA;
		routeCache.set(key(conn), { at: Date.now(), routes: updated });
		return updated;
	});
}

/**
 * What a layout wants for one output: an input number to show, "off" to blank
 * the screen, or null to leave that output exactly as it is.
 */
export type OutputTarget = number | "off" | null;

/** Enable state per output, cached so a layout only writes what actually changes. */
const enableCache = new Map<string, boolean[]>();

/**
 * Reads which outputs are currently lit. Blanking is separate from routing on
 * this device: a disabled output keeps its source but stops driving the screen.
 */
export async function getOutputEnabled(conn: MatrixConnection, outputs: number): Promise<boolean[]> {
	await awaitSettled(conn);
	const state: boolean[] = [];
	for (let out = 1; out <= outputs; out++) {
		const data = await send(conn, "GETNVRAM", { FIELD: `Output${out}Enable` });
		state.push(data[`Output${out}Enable`] === "1");
	}
	enableCache.set(key(conn), state);
	return state;
}

/** Blanks (false) or lights (true) a single output. */
export function setOutputEnabled(conn: MatrixConnection, out: number, enabled: boolean): Promise<void> {
	return enqueue(conn, async () => {
		await assertOk(conn, `SetOutput ${out} ${enabled ? 1 : 0}`);
		const state = enableCache.get(key(conn));
		if (state !== undefined && out >= 1 && out <= state.length) {
			state[out - 1] = enabled;
		}
	});
}

/**
 * Applies a whole desired state in one press: routes the outputs that name an
 * input, blanks the ones marked "off", and leaves nulls untouched.
 *
 * Outputs wanting the same input are batched into a single SW command, because
 * the protocol takes a list — fewer commands means less to go wrong and a
 * visibly cleaner transition than switching screens one at a time.
 */
export function applyLayout(conn: MatrixConnection, targets: OutputTarget[]): Promise<void> {
	return enqueue(conn, async () => {
		const routes = await getRoutes(conn);
		const enabled = enableCache.get(key(conn)) ?? (await getOutputEnabled(conn, routes.length));

		for (let i = 0; i < targets.length; i++) {
			const target = targets[i];
			if (typeof target === "number" && (i + 1 > routes.length || target < 1)) {
				throw new MatrixError(`Output ${i + 1} / input ${target} is out of range`);
			}
		}

		// Group outputs by the input they want, so each input costs one command.
		const byInput = new Map<number, number[]>();
		for (let i = 0; i < targets.length; i++) {
			const target = targets[i];
			if (typeof target !== "number" || routes[i] === target) {
				continue; // Not a routing change, or already showing that input.
			}
			const outs = byInput.get(target);
			if (outs === undefined) {
				byInput.set(target, [i + 1]);
			} else {
				outs.push(i + 1);
			}
		}

		const updated = [...routes];
		for (const [input, outs] of byInput) {
			await assertOk(conn, `SW ${input} ${outs.join(" ")}`);
			for (const out of outs) {
				updated[out - 1] = input;
			}
		}
		routeCache.set(key(conn), { at: Date.now(), routes: updated });

		// Only touch the outputs whose lit/blank state actually differs.
		for (let i = 0; i < targets.length; i++) {
			const target = targets[i];
			if (target === null || target === undefined) {
				continue;
			}
			const want = target !== "off";
			if (enabled[i] === want) {
				continue;
			}
			await assertOk(conn, `SetOutput ${i + 1} ${want ? 1 : 0}`);
			enabled[i] = want;
		}
		enableCache.set(key(conn), enabled);
	});
}

/**
 * Lights any dark outputs. Callers must already hold the write queue — going
 * through setOutputEnabled here would re-enter enqueue and deadlock on itself.
 */
async function lightAllInline(conn: MatrixConnection, outputs: number): Promise<void> {
	const k = key(conn);
	const enabled = enableCache.get(k) ?? (await getOutputEnabled(conn, outputs));
	for (let i = 0; i < outputs; i++) {
		if (!enabled[i]) {
			await assertOk(conn, `SetOutput ${i + 1} 1`);
			enabled[i] = true;
		}
	}
	enableCache.set(k, enabled);
}

/** Lights every output, undoing any blanking. */
export function enableAllOutputs(conn: MatrixConnection, outputs: number): Promise<void> {
	return enqueue(conn, () => lightAllInline(conn, outputs));
}

/** Reads the matrix's advertised input/output counts. */
export async function getSize(conn: MatrixConnection): Promise<{ inputs: number; outputs: number }> {
	const [inputs, outputs] = await Promise.all([
		readNvram(conn, "MatrixMaxIn"),
		readNvram(conn, "MatrixMaxOut"),
	]);
	return { inputs, outputs };
}

async function readNvram(conn: MatrixConnection, field: string): Promise<number> {
	const data = await send(conn, "GETNVRAM", { FIELD: field });
	const value = Number.parseInt(data[field] ?? "", 10);
	if (!Number.isFinite(value)) {
		throw new MatrixError(`GETNVRAM returned no value for ${field}`);
	}
	return value;
}
