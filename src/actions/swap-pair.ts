import {
	action,
	SingletonAction,
	type DidReceiveSettingsEvent,
	type KeyUpEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { getRoutes, swapOutputs } from "../matrix";
import { getConnection } from "../settings";

export type SwapPairSettings = {
	/** 1-based output numbers whose sources exchange on press. */
	outputA?: number;
	outputB?: number;
	/** Optional text drawn above the routing readout, e.g. "LEFT". */
	label?: string;
	/** Seconds between background refreshes of the key title; 0 disables. */
	pollSeconds?: number;
};

const DEFAULTS = { outputA: 1, outputB: 2, pollSeconds: 5 };

/**
 * Exchanges the two sources feeding a pair of outputs — e.g. the top and bottom
 * monitor on one side of the desk — without needing to know or care which
 * inputs are currently on them.
 */
@action({ UUID: "com.dgshue.mtviki.swap" })
export class SwapPair extends SingletonAction<SwapPairSettings> {
	/** One poll timer per visible key, so hidden profiles cost nothing. */
	readonly #timers = new Map<string, NodeJS.Timeout>();

	override async onWillAppear(ev: WillAppearEvent<SwapPairSettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override onWillDisappear(ev: WillDisappearEvent<SwapPairSettings>): void {
		this.#clear(ev.action.id);
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SwapPairSettings>): Promise<void> {
		this.#schedule(ev);
		await this.#render(ev);
	}

	override async onKeyUp(ev: KeyUpEvent<SwapPairSettings>): Promise<void> {
		const { outputA, outputB } = resolve(ev.payload.settings);
		if (outputA === outputB) {
			streamDeck.logger.warn(`Swap key ${ev.action.id} has both outputs set to ${outputA}`);
			await ev.action.showAlert();
			return;
		}

		try {
			const routes = await swapOutputs(await getConnection(), outputA, outputB);
			await ev.action.setTitle(title(ev.payload.settings, routes));
		} catch (err) {
			streamDeck.logger.error(`Swap ${outputA}<->${outputB} failed`, err);
			await ev.action.setTitle(title(ev.payload.settings, null));
			await ev.action.showAlert();
		}
	}

	#schedule(ev: WillAppearEvent<SwapPairSettings> | DidReceiveSettingsEvent<SwapPairSettings>): void {
		this.#clear(ev.action.id);
		const seconds = resolve(ev.payload.settings).pollSeconds;
		if (seconds <= 0) {
			return;
		}
		const timer = setInterval(() => void this.#render(ev), seconds * 1000);
		this.#timers.set(ev.action.id, timer);
	}

	#clear(id: string): void {
		const timer = this.#timers.get(id);
		if (timer !== undefined) {
			clearInterval(timer);
			this.#timers.delete(id);
		}
	}

	/** Refreshes the key title with the live routing, or a dash when offline. */
	async #render(ev: { action: { setTitle(t: string): Promise<void> }; payload: { settings: SwapPairSettings } }): Promise<void> {
		try {
			const routes = await getRoutes(await getConnection());
			await ev.action.setTitle(title(ev.payload.settings, routes));
		} catch {
			await ev.action.setTitle(title(ev.payload.settings, null));
		}
	}
}

function resolve(settings: SwapPairSettings) {
	return {
		outputA: toInt(settings.outputA, DEFAULTS.outputA),
		outputB: toInt(settings.outputB, DEFAULTS.outputB),
		pollSeconds: toInt(settings.pollSeconds, DEFAULTS.pollSeconds),
	};
}

function toInt(value: unknown, fallback: number): number {
	const n = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(n) ? n : fallback;
}

/** e.g. "LEFT\n3 / 1" — the input on output A over the input on output B. */
function title(settings: SwapPairSettings, routes: number[] | null): string {
	const { outputA, outputB } = resolve(settings);
	const head = settings.label?.trim();
	const body = routes === null
		? "—"
		: `${routes[outputA - 1] ?? "?"} / ${routes[outputB - 1] ?? "?"}`;
	return head ? `${head}\n${body}` : body;
}
