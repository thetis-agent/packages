// What the fence can see of the call as of the bench phase. This is a second opinion, not the measurement:
// `call.messages` is still empty here (the built-in call fills it from the conversation) and the cache hints
// have not been added yet, so byte accounting belongs to the provider. What is useful here is the step
// ordering and the tool list, which prove the bench phase ran and in what company.
export function observe(ctx) {
  return {
    model: ctx.call.model,
    systemBytes: Buffer.byteLength(ctx.call.system ?? "", "utf8"),
    tools: (ctx.call.tools ?? []).map((t) => t.name).sort(),
    packages: ctx.packages.list().map((p) => `${p.name}@${p.version}`).sort(),
    conversation: ctx.conversation.length,
  };
}
