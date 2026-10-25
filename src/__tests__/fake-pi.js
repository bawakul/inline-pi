/**
 * Fake `pi --mode rpc` harness for unit tests.
 *
 * Reads JSONL requests from stdin and writes JSONL responses to stdout.
 * Scenario is selected by substring in the prompt message:
 *   "happy"   -> text deltas + message_end + agent_settled
 *   "error"   -> auto_retry_start/end + agent_settled with stopReason:error
 *   "abort"   -> waits for an abort request, then agent_settled{aborted:true}
 *   "dialog"  -> extension_ui_request confirm, then text delta + settle
 *   "handled" -> disposition:handled (no stream, no agent_settled)
 *   "u2028"   -> text_delta containing U+2028 inside the JSON string
 *   "tools"   -> turn_start + tool_execution_start/end (read, bash) +
 *                message_update text + agent_settled (exercises issue #6)
 */
function send(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
}
let buffer = "";
let activeId = null;
function readScenario(message) {
    const m = message.toLowerCase();
    if (m.includes("handled"))
        return "handled";
    if (m.includes("error"))
        return "error";
    if (m.includes("abort"))
        return "abort";
    if (m.includes("dialog"))
        return "dialog";
    if (m.includes("tools"))
        return "tools";
    if (m.includes("u2028") || m.includes("\u2028"))
        return "u2028";
    return "happy";
}
function runHappy(id) {
    send({ id, type: "response", data: { disposition: "started" } });
    send({
        id,
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
    });
    send({
        id,
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: " world" },
    });
    send({ id, type: "message_end", message: "Hello world" });
    send({ id, type: "agent_settled", stopReason: "stop" });
    activeId = null;
}
function runError(id) {
    send({ id, type: "response", data: { disposition: "started" } });
    send({ id, type: "auto_retry_start" });
    send({ id, type: "auto_retry_end", success: false });
    send({
        id,
        type: "agent_settled",
        stopReason: "error",
        errorMessage: "provider failure",
    });
    activeId = null;
}
function runDialog(id) {
    send({ id, type: "response", data: { disposition: "started" } });
    send({
        type: "extension_ui_request",
        id: "dlg-1",
        method: "confirm",
        params: { message: "Allow?" },
    });
    setTimeout(() => {
        send({
            id,
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "ok" },
        });
        send({ id, type: "agent_settled", stopReason: "stop" });
        activeId = null;
    }, 10);
}
function runTools(id) {
    send({ id, type: "response", data: { disposition: "started" } });
    send({ id, type: "agent_start" });
    send({ id, type: "turn_start" });
    send({ id, type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "foo.txt" } });
    send({ id, type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: {}, partialResult: "" });
    send({ id, type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "", isError: false, durationMs: 5 });
    send({ id, type: "tool_execution_start", toolCallId: "call-2", toolName: "bash", args: { command: "ls" } });
    send({ id, type: "tool_execution_end", toolCallId: "call-2", toolName: "bash", result: "", isError: false, durationMs: 3 });
    send({ id, type: "turn_end", message: {}, toolResults: [] });
    send({ id, type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Done." } });
    send({ id, type: "message_end", message: "Done." });
    send({ id, type: "agent_settled", stopReason: "stop" });
    activeId = null;
}
function runU2028(id) {
    send({ id, type: "response", data: { disposition: "started" } });
    send({
        id,
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "line1\u2028line2" },
    });
    send({ id, type: "agent_settled", stopReason: "stop" });
    activeId = null;
}
function handlePrompt(msg) {
    var _a, _b;
    const id = String((_a = msg.id) !== null && _a !== void 0 ? _a : "unknown");
    activeId = id;
    const scenario = readScenario(String((_b = msg.message) !== null && _b !== void 0 ? _b : ""));
    switch (scenario) {
        case "handled":
            send({ id, type: "response", data: { disposition: "handled" } });
            activeId = null;
            break;
        case "error":
            runError(id);
            break;
        case "dialog":
            runDialog(id);
            break;
        case "tools":
            runTools(id);
            break;
        case "u2028":
            runU2028(id);
            break;
        case "abort":
            // For abort scenario: send started response and wait for abort message
            send({ id, type: "response", data: { disposition: "started" } });
            // activeId stays set until abort is received
            break;
        default:
            runHappy(id);
    }
}
process.stdin.on("data", (chunk) => {
    var _a;
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = (_a = lines.pop()) !== null && _a !== void 0 ? _a : "";
    for (const line of lines) {
        if (!line.trim())
            continue;
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch (_b) {
            send({ command: "parse", error: "invalid JSON" });
            continue;
        }
        if (msg.type === "prompt") {
            handlePrompt(msg);
        }
        else if (msg.type === "abort") {
            if (activeId) {
                send({ id: activeId, type: "agent_settled", aborted: true });
                activeId = null;
            }
        }
    }
});
