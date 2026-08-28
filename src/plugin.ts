import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { SetRoute } from "./actions/set-route";
import { SwapPair } from "./actions/swap-pair";

streamDeck.logger.setLevel(LogLevel.INFO);

streamDeck.actions.registerAction(new SwapPair());
streamDeck.actions.registerAction(new SetRoute());

streamDeck.connect();
