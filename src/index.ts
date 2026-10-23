import InlinePiPlugin from "./main";
export { InlinePiPlugin };
export type { InlinePiPluginLike, InlinePiSettings } from "./types";
export { PiClient, type PiClientOptions, type PiSettleResult } from "./pi-client";
export { InlinePiSuggest } from "./suggest";
export { InlinePiSettingTab } from "./settings";

// Callout streaming
export { insertPendingCallout, buildErrorCallout, type CalloutHandle, type CalloutState } from "./callout-streaming";

// Instruction payload (D4)
export { INSTRUCTIONS_PREFIX, buildPromptInstructions } from "./instructions";
