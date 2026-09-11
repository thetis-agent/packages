/** Negotiate only control and completion metadata across the monitor channel; ADR 0019, ADR 0027. */
import { sessionMethods as methods } from '@/lib/socket/sessions.ts';
export const sessionMethods = methods.filter(method => method !== 'session.subscribe');
/* `session.request` is offered here and nowhere else: a contributed panel's command reaches the
 * package that declared it over this connection, which already carries the conversation it is bound
 * to, and never over the inherited kernel channel (ADR 0051). */
export const publicCapabilities = ['health.probe', ...methods, 'session.request', 'notice'];
export const capabilities = ['health.probe', ...sessionMethods, 'run.stop', 'env.updated', 'turn.report', 'notice'];
