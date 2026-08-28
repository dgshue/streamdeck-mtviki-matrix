import streamDeck from "@elgato/streamdeck";
import { DEFAULT_CONNECTION, type MatrixConnection } from "./matrix";

/** Connection details live in global settings so every button shares one config. */
export type GlobalSettings = {
	host?: string;
	username?: string;
	password?: string;
};

export async function getConnection(): Promise<MatrixConnection> {
	const global = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
	return {
		host: global.host?.trim() || DEFAULT_CONNECTION.host,
		username: global.username?.trim() || DEFAULT_CONNECTION.username,
		password: global.password ?? DEFAULT_CONNECTION.password,
	};
}
