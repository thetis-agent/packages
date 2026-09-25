/** An error with a code the kernel's control channel passes through, as `@thetis/runtime/lib/error` shapes them. */
export class HostError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function assert(condition, message, code = "invalid") {
  if (!condition) throw new HostError(message, code);
}
