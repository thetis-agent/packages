/** Let a contributed panel act, within what its package declared; contract/surface, ADR 0051.
 *
 * ADR 0038 §1 gave packages a way to draw an inspector and `lib/surface.js` stated the rule that made
 * that safe: a panel reads frames the surface already has and sends nothing. This file is the one
 * hole in that rule and the whole of it. A terminal, a todo pane and an `ask_user` form each need to
 * send something, and building all three into `gateway-web` would abandon the acceptance test
 * contract/surface set for a contributed panel — that adding one leaves `git diff packages/gateway-web`
 * empty. So a panel may send, and what it may send is a list its own package published.
 *
 * Four checks, all of them here and none of them in the browser. The package contributed a panel to
 * this surface. The verb is one that package declared. The signed-in role clears whatever the
 * declaration asked for. The conversation is one this connection has open — which is also the route:
 * the request travels down the environment stream already subscribed to it (lib/session/client.ts),
 * so the environment refuses a mismatch without consulting anything.
 *
 * A refusal is an answer, never an `error` frame. The socket's `error` frame is a fault in the socket
 * itself and app.js releases every pending send when one arrives; a panel being told no is neither of
 * those things, and it must reach the panel that asked and nothing else.
 */
import type { Command } from '@/contracts/surface/types.ts';
import type { CallAnswer } from '@/contracts/turn-events/types.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Declared } from './panels.ts';
import type { Contract } from './types.ts';
import { settings } from './index.ts';

export type Send = (frame: Record<string, unknown>) => Promise<Result<void>>;
/** The half of `lib/session/client.ts` this needs: one open conversation's stream, which is also the
 *  binding — a request goes down the stream already reading that conversation, or it is refused. */
export interface Stream { request(conversation: string, name: string, verb: string, args: Record<string, unknown>): Promise<Result<CallAnswer>> }
/** The three roles the kernel knows, least first; a declaration naming one admits it and everything
 *  above it. An unknown role clears nothing, so a connection whose role the gateway could not read
 *  can still read panels and still cannot act through one. */
const ranks = ['user', 'reviewer', 'admin'];
const clears = (role: string, least: string | undefined): boolean =>
  least === undefined ? ranks.includes(role) : ranks.indexOf(role) >= ranks.indexOf(least) && ranks.includes(role);

/** What a panel may be handed back from one answer, in UTF-8 bytes like every other budget here. The
 *  environment already bounds what it asks a package for; this bounds what crosses to the browser. */
export const limits = { answerBytes: 65536 };

/** Refusals a person reads. They say what happened, not what the machinery calls it. */
const refusals = {
  unknown: 'That panel is not allowed to do this.',
  role: 'You do not have permission to do this.',
  closed: 'That conversation is not open any more.',
  full: 'Too much is happening at once. Try that again in a moment.',
  failed: 'That did not work. Nothing was changed.',
};

/** Caps an answer's text at `limits.answerBytes`, measured in UTF-8 bytes as render.ts measures its own. */
function cap(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  return buffer.byteLength <= limits.answerBytes ? value : buffer.subarray(0, limits.answerBytes).toString('utf8');
}

export class SurfaceRequests {
  readonly #declared = new Map<string, Map<string, Command>>();
  readonly #role: string;
  readonly #stream: (conversation: string) => Stream | undefined;
  readonly #send: Send;
  #pending = 0;

  constructor(declared: readonly Declared[], role: string, stream: (conversation: string) => Stream | undefined, send: Send) {
    // Flattened once, at connection time, from a list that was read once at start: a package's reach
    // is fixed when it is published and reviewed, and nothing at runtime can widen it.
    for (const entry of declared) this.#declared.set(entry.package, new Map(entry.commands.map(command => [command.verb, command])));
    this.#role = role; this.#stream = stream; this.#send = send;
  }

  /** True when this frame is a panel's request, so the caller can delegate in one line. */
  static claims(input: Contract): boolean { return input.type === 'surface-request'; }

  async handle(input: Contract): Promise<Result<void>> {
    const request = input['request'];
    // Without an id there is nobody to answer, which is a malformed frame rather than a refusal.
    if (typeof request !== 'string' || !request) return failure('invalid-args', 'The gateway request has no reply address.');
    const name = input['package']; const verb = input['verb']; const args: unknown = input['args'] ?? {};
    if (typeof name !== 'string' || typeof verb !== 'string' || !isObject(args)) return this.#refuse(request, input.id, refusals.unknown);
    const declared = this.#declared.get(name)?.get(verb);
    if (!declared) return this.#refuse(request, input.id, refusals.unknown);
    if (!clears(this.#role, typeof declared['role'] === 'string' ? declared['role'] : undefined)) return this.#refuse(request, input.id, refusals.role);
    const conversation = input.id;
    if (typeof conversation !== 'string') return this.#refuse(request, undefined, refusals.closed);
    const stream = this.#stream(conversation);
    if (!stream) return this.#refuse(request, conversation, refusals.closed);
    // Bounded like every other pool on this connection (settings.pendingIdentity): a panel that asks
    // faster than the environment answers is refused rather than allowed to queue work behind itself.
    if (this.#pending >= settings.pendingRequests) return this.#refuse(request, conversation, refusals.full);
    this.#pending++;
    try {
      const answer = await stream.request(conversation, name, verb, args);
      // A transport failure is said plainly and never forwarded: those messages name deadlines,
      // sockets and methods, which is the vocabulary the house rules keep off the screen. A package's
      // own refusal is forwarded, because the package is the only thing that knows what it refused.
      if (!answer.ok) return await this.#refuse(request, conversation, refusals.failed);
      if (!answer.value.ok) return await this.#refuse(request, conversation, answer.value.error?.message ?? refusals.failed);
      const text = cap((answer.value.content ?? []).map(part => part.type === 'text' ? part.text : '').join(''));
      return await this.#send({ type: 'surface-answer', request, session: conversation, ok: true,
        ...(text ? { text } : {}), ...(answer.value.data ? { data: answer.value.data } : {}) });
    } finally { this.#pending--; }
  }

  #refuse(request: string, session: string | undefined, message: string): Promise<Result<void>> {
    return this.#send({ type: 'surface-answer', request, ...(session === undefined ? {} : { session }), ok: false, message });
  }
}
