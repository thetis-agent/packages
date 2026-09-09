/** Negotiate only control and completion metadata across the monitor channel; ADR 0019, ADR 0027. */
import { sessionMethods as methods } from '../../lib/socket/sessions.ts';
export const sessionMethods = methods.filter(method => method !== 'session.subscribe');
export const publicCapabilities = ['health.probe', ...methods, 'notice'];
export const capabilities = ['health.probe', ...sessionMethods, 'run.stop', 'env.updated', 'turn.report', 'notice'];
