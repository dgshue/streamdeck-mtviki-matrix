import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { Layout } from "./actions/layout";
import { MonitorInput } from "./actions/monitor-input";
import { ResetIdentity } from "./actions/reset-identity";
import { SetRoute } from "./actions/set-route";
import { SwapPair } from "./actions/swap-pair";

// DEBUG so INFO-level diagnostics reach the plugin log file.
streamDeck.logger.setLevel(LogLevel.DEBUG);

streamDeck.actions.registerAction(new SwapPair());
streamDeck.actions.registerAction(new SetRoute());
streamDeck.actions.registerAction(new ResetIdentity());
streamDeck.actions.registerAction(new Layout());
streamDeck.actions.registerAction(new MonitorInput());

streamDeck.connect();
