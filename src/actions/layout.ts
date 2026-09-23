import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

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
};

const MAX_OUTPUTS = 4;
const DEFAULT_POLL_SECONDS = 5;

/**
 * Applies a whole desk arrangement in one press — some screens routed, some
 * blanked, some left alone. The thing a single route command cannot express.
 */
@action({ UUID: "com.dgshue.mtviki.layout" })
export class Layout extends SingletonAction<LayoutSettings> {
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

		try {
			await applyLayout(await getConnection(), targets);
			await this.#render(ev);
			await ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error("Applying layout failed", err);
			await ev.action.setTitle(titleFor(ev.payload.settings, null, null));
			await ev.action.showAlert();
		}
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
