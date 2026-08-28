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
