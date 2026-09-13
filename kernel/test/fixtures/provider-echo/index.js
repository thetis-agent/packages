// Deterministic provider for tests. "run: <cmd>" asks for the exec tool; a tool result is echoed back.
export function createProvider(config) {
  return {
    async models() { return [{ id: "echo" }]; },
    async *call(call) {
      const last = call.messages[call.messages.length - 1];
      if (last?.role === "tool") { yield { type: "text", delta: `tool said: ${last.content}` }; return; }
      const text = last?.content ?? "";
      if (text.startsWith("run: ") && call.tools.some((t) => t.name === "exec")) {
        yield { type: "tool_call", call: { id: "c1", name: "exec", args: { cmd: text.slice(5) } } };
        return;
      }
      if (text.startsWith("install: ")) {
        yield { type: "tool_call", call: { id: "c2", name: "install_package", args: { source: text.slice(9) } } };
        return;
      }
      if (text.startsWith("slow: ")) {
        // Streams one word every 50 ms, so a test can cancel mid-stream.
        for (const word of text.slice(6).split(" ")) { await new Promise((r) => setTimeout(r, 50)); yield { type: "text", delta: word + " " }; }
        return;
      }
      if (text === "system?") { yield { type: "text", delta: call.system ?? "" }; return; }
      if (text === "tools?") { yield { type: "text", delta: call.tools.map((t) => t.name).join(",") }; return; }
      yield { type: "text", delta: `echo: ${text} (${config.tag ?? "untagged"})` };
    },
  };
}
