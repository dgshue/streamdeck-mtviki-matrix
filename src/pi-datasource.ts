import type { JsonObject, JsonValue, SendToPluginEvent } from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { inputChoices, monitorChoices } from "./ddc";

/**
 * Serves the property inspector's dropdowns.
 *
 * sdpi-components asks by posting `{ event: "<datasource>" }` and waits for a
 * reply whose payload carries the same event name plus `items`.
 *
 * These lists are read from the hardware rather than typed in by hand. The
 * previous version used placeholder text for the monitor, which renders grey
 * and looks exactly like a saved value — so a key could sit there apparently
 * configured while the setting was empty and the whole step silently skipped.
 */
export async function handlePiDatasource<T extends JsonObject>(
	ev: SendToPluginEvent<JsonValue, T>,
): Promise<boolean> {
	const event = (ev.payload as { event?: string } | null)?.event;
	if (event !== "getMonitors" && event !== "getInputs") {
		return false;
	}

	const send = async (items: unknown): Promise<void> => {
		await streamDeck.ui.current?.sendToPropertyInspector({ event, items } as JsonValue);
	};

	try {
		await send(event === "getMonitors" ? await monitorChoices() : await inputChoices());
	} catch (err) {
		streamDeck.logger.error(`Failed to build ${event} list`, err);
		await send([{ label: "Could not read monitors", value: "", disabled: true }]);
	}
	return true;
}
