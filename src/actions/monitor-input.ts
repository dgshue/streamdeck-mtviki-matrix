import { action, SingletonAction, type KeyUpEvent } from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { setVcp } from "../ddc";

export type MonitorInputSettings = {
	/** Substring of the monitor's capability string, e.g. "U2414H". */
	match?: string;
	/** VCP feature code; 0x60 is input source. */
	code?: string;
	value?: string;
};

/**
 * Switches a monitor's own input source over DDC/CI.
 *
 * Also the way back: if a layout points a screen at an input with no signal,
 * the monitor shows nothing and its OSD is the only other escape. A key that
 * can always send it to a known-good input is worth having on the deck.
 */
@action({ UUID: "com.dgshue.mtviki.monitor" })
export class MonitorInput extends SingletonAction<MonitorInputSettings> {
	override async onKeyUp(ev: KeyUpEvent<MonitorInputSettings>): Promise<void> {
		const match = ev.payload.settings.match?.trim() ?? "";
		const value = Number.parseInt(String(ev.payload.settings.value ?? ""), 10);

		if (match === "" || !Number.isFinite(value)) {
			streamDeck.logger.warn(`Monitor input key ${ev.action.id} is not configured`);
			await ev.action.showAlert();
			return;
		}

		try {
			await setVcp({ match, code: ev.payload.settings.code?.trim() || "0x60", value });
			await ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error(`Switching ${match} to input ${value} failed`, err);
			await ev.action.showAlert();
		}
	}
}
