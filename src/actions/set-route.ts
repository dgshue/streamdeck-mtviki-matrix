import { action, SingletonAction, type KeyUpEvent } from "@elgato/streamdeck";
import streamDeck from "@elgato/streamdeck";

import { route } from "../matrix";
import { getConnection } from "../settings";

export type SetRouteSettings = {
	input?: number;
	/** Comma or space separated 1-based output numbers, e.g. "1,3". */
	outputs?: string;
	label?: string;
};

/** Sends one input to a fixed set of outputs — the "put the laptop up top" key. */
@action({ UUID: "com.dgshue.mtviki.route" })
export class SetRoute extends SingletonAction<SetRouteSettings> {
	override async onKeyUp(ev: KeyUpEvent<SetRouteSettings>): Promise<void> {
		const input = Number.parseInt(String(ev.payload.settings.input ?? ""), 10);
		const outputs = parseOutputs(ev.payload.settings.outputs);

		if (!Number.isFinite(input) || outputs.length === 0) {
			streamDeck.logger.warn(`Route key ${ev.action.id} is not configured`);
			await ev.action.showAlert();
			return;
		}

		try {
			await route(await getConnection(), input, outputs);
			await ev.action.showOk();
		} catch (err) {
			streamDeck.logger.error(`Route input ${input} -> ${outputs.join(",")} failed`, err);
			await ev.action.showAlert();
		}
	}
}

function parseOutputs(raw: string | undefined): number[] {
	return (raw ?? "")
		.split(/[\s,]+/)
		.map((part) => Number.parseInt(part, 10))
		.filter((n) => Number.isFinite(n) && n > 0);
}
