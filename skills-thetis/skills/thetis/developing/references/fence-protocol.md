# Changing what crosses the fence

Two different things, with different edit lists. Missing a file gives a runtime error and no compile-time
signal from the others, so make the whole list in one change.

## A new RPC method, which a fence calls on the kernel

Three files:

1. `packages/kernel/src/rpc.ts` : a `case` in `createRpcHandler`. This is the authority side, and it runs
   as the fence's own user. No argument may name another user.
2. `packages/userspace-agent/src/agent.ts` : the client method on the agent's `kernel` object, which is
   what package code actually calls as `env.kernel.<...>`.
3. `packages/contracts/src/guest.ts` : the method on `KernelClient`, so package code has a type for it.

A method that is not in the kernel's table fails with the code `rpc`.

## A new fence operation, which the kernel sends to the agent

Two files:

1. `packages/userspace-agent/src/agent.ts` : a handler in `ops`.
2. The caller in the kernel, through `Fences.request`.

## Shared

Both directions use the framing in `@thetis/lib/rpc-frames`: one JSON object per line, zero or more
`event` lines, then exactly one `result` or `error`. The kernel's side of one agent process is
`packages/sandbox/src/handle.ts`, which also owns the request timer and cancellation.

Package code that writes to `process.stdout` corrupts this channel. That is why the agent redirects
`console.log` to stderr, and why a service must use `env.log`.
