import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { getRoutes, resetIdentity } from "../matrix";
import { getConnection } from "../settings";

export type ResetIdentitySettings = {
	/** Optional text drawn above the readout, e.g. "RESET". */
	label?: string;
	/** Seconds between background refreshes of the key title; 0 disables. */
	pollSeconds?: number;
};

const DEFAULT_POLL_SECONDS = 5;

/**
 * Puts every screen back where it belongs — input 1 to output 1, 2 to 2, and so
 * on. The home key for when the swaps have left things somewhere confusing.
 */
@action({ UUID: "com.dgshue.mtviki.identity" })
export class ResetIdentity extends SingletonAction<ResetIdentitySettings> {
	/** One poll timer per visible key, so hidden profiles cost nothing. */
	readonly #timers = new Map<string, NodeJS.Timeout>();

	override async onWillAppear(ev: WillAppearEvent<ResetIdentitySettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override onWillDisappear(ev: WillDisappearEvent<ResetIdentitySettings>): void {
		this.#clear(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<ResetIdentitySettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override async onKeyUp(ev: KeyUpEvent<ResetIdentitySettings>): Promise<void> {
		try {
			const routes = await resetIdentity(await getConnection());
			await ev.action.setTitle(title(ev.payload.settings, routes.length > 0 ? routes : null));
			await ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error("Reset to default routing failed", err);
			await ev.action.setTitle(title(ev.payload.settings, null));
			await ev.action.showAlert();
		}
	}

	#schedule(
		ev: WillAppearEvent<ResetIdentitySettings> | DidReceiveSettingsEvent<ResetIdentitySettings>,
	): void {
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

	/** Shows the live map, so the key doubles as an "are we at default?" readout. */
	async #render(ev: {
		action: { setTitle(t: string): Promise<void> };
		payload: { settings: ResetIdentitySettings };
	}): Promise<void> {
		try {
			await ev.action.setTitle(title(ev.payload.settings, await getRoutes(await getConnection())));
		} catch {
			await ev.action.setTitle(title(ev.payload.settings, null));
		}
	}
}

function toInt(value: unknown, fallback: number): number {
	const n = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(n) ? n : fallback;
}

/** e.g. "RESET\n1 2 3 4", or "RESET\n✓" when already at default. */
function title(settings: ResetIdentitySettings, routes: number[] | null): string {
	const head = settings.label?.trim() ?? "";
	let body: string;
	if (routes === null) {
		body = "—";
	} else if (routes.every((input, index) => input === index + 1)) {
		body = "✓";
	} else {
		body = routes.join(" ");
	}
	return head ? `${head}\n${body}` : body;
}
