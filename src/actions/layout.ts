import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";
import type { JsonValue, SendToPluginEvent } from "@elgato/streamdeck";

import { setVcp } from "../ddc";
import { handlePiDatasource } from "../pi-datasource";
import { applyLayout, getOutputEnabled, getRoutes, type OutputTarget } from "../matrix";
import { getConnection } from "../settings";

/**
 * Per-output target, stored as the strings the property inspector produces:
 * "" / "keep" to leave alone, "off" to blank, or an input number.
 */
export type LayoutSettings = {
	out1?: string;
	out2?: string;
	out3?: string;
	out4?: string;
	label?: string;
	pollSeconds?: number;
	/**
	 * Optional DDC/CI step: also switch a monitor's own input source, for a
	 * screen that is wired to something besides the matrix. Empty match = off.
	 */
	ddcMatch?: string;
	ddcCode?: string;
	ddcValue?: string;
};

const MAX_OUTPUTS = 4;
const DEFAULT_POLL_SECONDS = 5;

/**
 * Applies a whole desk arrangement in one press — some screens routed, some
 * blanked, some left alone. The thing a single route command cannot express.
 */
@action({ UUID: "com.dgshue.mtviki.layout" })
export class Layout extends SingletonAction<LayoutSettings> {
	/** Populates the monitor and input dropdowns from live hardware. */
	override async onSendToPlugin(ev: SendToPluginEvent<JsonValue, LayoutSettings>): Promise<void> {
		await handlePiDatasource(ev);
	}

	readonly #timers = new Map<string, NodeJS.Timeout>();

	override async onWillAppear(ev: WillAppearEvent<LayoutSettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override onWillDisappear(ev: WillDisappearEvent<LayoutSettings>): void {
		this.#clear(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<LayoutSettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override async onKeyUp(ev: KeyUpEvent<LayoutSettings>): Promise<void> {
		const targets = parseTargets(ev.payload.settings);
		if (targets.every((t) => t === null)) {
			streamDeck.logger.warn(`Layout key ${ev.action.id} has nothing to apply`);
			await ev.action.showAlert();
			return;
		}

		// The matrix and the monitor are independent devices, so run both at once
		// rather than making the key wait for the sum of two round trips.
		const [matrixResult, ddcResult] = await Promise.allSettled([
			applyLayout(await getConnection(), targets),
			this.#switchMonitorInput(ev.payload.settings),
		]);

		// Report both halves independently. Returning early on a matrix failure
		// used to discard the DDC outcome, which is precisely how a silently
		// skipped monitor switch went unnoticed.
		if (ddcResult.status === "rejected") {
			streamDeck.logger.error("Monitor input switch failed", ddcResult.reason);
		}
		if (matrixResult.status === "rejected") {
			streamDeck.logger.error("Applying layout failed", matrixResult.reason);
			await ev.action.setTitle(titleFor(ev.payload.settings, null, null));
			await ev.action.showAlert();
			return;
		}

		await this.#render(ev);

		if (ddcResult.status === "rejected") {
			await ev.action.showAlert();
			return;
		}

		await ev.action.showOk();
	}

	/** No-ops unless a monitor match is configured. */
	async #switchMonitorInput(settings: LayoutSettings): Promise<void> {
		const match = settings.ddcMatch?.trim() ?? "";
		const value = Number.parseInt(String(settings.ddcValue ?? ""), 10);

		if (match === "" && !Number.isFinite(value)) {
			return; // Genuinely not configured; nothing to say.
		}
		if (match === "" || !Number.isFinite(value)) {
			// Half-configured is a mistake, not an intention. Failing loudly here is
			// what turns "the key quietly did nothing" into something findable.
			throw new Error(
				`DDC step is half-configured: monitor=${JSON.stringify(settings.ddcMatch)} `
					+ `input=${JSON.stringify(settings.ddcValue)}. Set both, or neither.`,
			);
		}
		const result = await setVcp({ match, code: settings.ddcCode?.trim() || "0x60", value });
		streamDeck.logger.info(
			result.changed
				? `DDC ${match}: input ${result.previous} -> ${value}`
				: `DDC ${match}: already on input ${value}`,
		);
	}

	#schedule(ev: WillAppearEvent<LayoutSettings> | DidReceiveSettingsEvent<LayoutSettings>): void {
		this.#clear(ev.action.id);
		const seconds = toInt(ev.payload.settings.pollSeconds, DEFAULT_POLL_SECONDS);
		if (seconds <= 0) {
			return;
		}
		this.#timers.set(ev.action.id, setInterval(() => void this.#render(ev), seconds * 1000));
	}

	#clear(id: string): void {
		const timer = this.#timers.get(id);
		if (timer !== undefined) {
			clearInterval(timer);
			this.#timers.delete(id);
		}
	}

	async #render(ev: {
		action: { setTitle(t: string): Promise<void> };
		payload: { settings: LayoutSettings };
	}): Promise<void> {
		try {
			const conn = await getConnection();
			const routes = await getRoutes(conn);
			const enabled = await getOutputEnabled(conn, routes.length);
			await ev.action.setTitle(titleFor(ev.payload.settings, routes, enabled));
		} catch {
			await ev.action.setTitle(titleFor(ev.payload.settings, null, null));
		}
	}
}

/** Reads the four per-output dropdowns into the client's target shape. */
function parseTargets(settings: LayoutSettings): OutputTarget[] {
	const raw = [settings.out1, settings.out2, settings.out3, settings.out4];
	return raw.slice(0, MAX_OUTPUTS).map((value) => {
		const v = (value ?? "").trim().toLowerCase();
		if (v === "off") {
			return "off";
		}
		if (v === "" || v === "keep") {
			return null;
		}
		const n = Number.parseInt(v, 10);
		return Number.isFinite(n) ? n : null;
	});
}

function toInt(value: unknown, fallback: number): number {
	const n = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(n) ? n : fallback;
}

/** e.g. "WRITING\n1 · 3" — input per screen, with a dot for a blanked one. */
function titleFor(
	settings: LayoutSettings,
	routes: number[] | null,
	enabled: boolean[] | null,
): string {
	const head = settings.label?.trim() ?? "";
	const body =
		routes === null
			? "—"
			: routes.map((input, i) => (enabled?.[i] === false ? "·" : String(input))).join(" ");
	return head ? `${head}\n${body}` : body;
}
