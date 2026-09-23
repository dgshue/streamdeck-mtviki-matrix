import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { ResetIdentity } from "./actions/reset-identity";
import { SetRoute } from "./actions/set-route";
import { SwapPair } from "./actions/swap-pair";

streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new SwapPair());
streamDeck.actions.registerAction(new SetRoute());
streamDeck.actions.registerAction(new ResetIdentity());

streamDeck.connect();
