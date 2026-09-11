/** Answer the operator surface's commands from what this deployment actually offers, re-checking the
 * signed-in role on every one; ADR 0018 §3, ADR 0050.
 *
 * ADR 0018 §3 puts the review page in the web UI package — the diff, the note, the checks, the scores
 * and who runs it are a gateway's to display — and ADR 0050 completes that by offering `default.prepare`
 * and `default.set` on the package socket, so a reviewer acts where the evidence already is. That is
 * why this lives in `gateway-web` rather than in a contributed panel: `assets/lib/surface.js` says in
 * its own header that a panel cannot invent traffic, and the operator surface is nothing but traffic.
 * Widening `contract/surface` so a third-party package could drive an install is precisely the fence
 * ADR 0050 reasoned about rather than casually removed.
 *
 * Two rules govern every handler here.
 *
 * The first is that the role is re-checked server-side. `hello` tells the browser the signed-in role so
 * it can leave controls out, but hiding a button is a courtesy, not a gate; each command below asks
 * `#above` again before it touches the socket. The kernel checks a third time — `Act` refuses a `user`,
 * `Runtime.status`/`reset` refuse another person's environment — and that is the check that actually
 * holds. These two exist so a refusal is shaped like an answer instead of arriving as a socket fault.
 *
 * The second is that a capability this deployment withheld degrades into an `unsupported` answer rather
 * than a throw or an invented reply, exactly as `wire.ts`'s `env.status` seam already does. The surface
 * asks once what is available (`admin.open`) and draws only the sections that have something behind
 * them; a section with nothing behind it is left out rather than shown broken.
 */
import type { Peer } from '@/lib/socket/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import type { Contract } from './types.ts';
import type { Send } from './wire.ts';

/** Bounds every window this seam will answer, named rather than inline per the house rule. `logRows`
 * mirrors `lib/deployment/logs.ts`'s own ceiling, which clamps anything larger on the kernel side. */
export const adminLimits = { logRows: 200, packages: 256, spaces: 64, digestChars: 256 };

/** Roles above `user`, in the order `contract/deployment`'s `Principal` declares them. A command that
 * names a minimum is refused for anyone below it. */
const ranks = { user: 0, reviewer: 1, admin: 2 } as const;
const rank = (role: string): number => role in ranks ? ranks[role as keyof typeof ranks] : 0;

/** One row of the package table: what a person is shown about something installed here.
 *
 * `scope` is the real axis behind "only me" and "everyone" — it is a package's declared spawn scope,
 * not a preference, and there is no third value to invent. `network` is fixed when a package is
 * installed and is reported, never offered as a setting. */
export interface Installed { name: string; version: string; scope: 'person' | 'deployment'; internet: boolean; needs: string[]; gives: string[] }
/** What `profile.get` turned out to describe. Every field is optional because a deployment describes
 * as much or as little as it chooses, and the surface draws exactly what arrived. */
export interface Described {
  packages: Installed[];
  model?: { model: string; provider: string };
  mode?: { readOnly: boolean; deny: string[] };
  limits?: { maxIterations?: number; maxTokens?: number; temperature?: number };
  spaces?: { path: string; mode: string; space: string }[];
}

function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }

/** Reads the `Setup` record `profile.get` may answer with into the handful of plain facts the surface
 * shows. Deliberately total: anything missing or misshapen is simply absent from the result, because a
 * deployment that describes nothing must produce an empty control panel rather than a refusal. */
export function describe(value: unknown): Described {
  const described: Described = { packages: [] };
  if (!isObject(value)) return described;
  const entries = Array.isArray(value['entries']) ? value['entries'] : [];
  for (const entry of entries.slice(0, adminLimits.packages)) {
    if (!isObject(entry) || !isObject(entry['manifest'])) continue;
    const manifest = entry['manifest'];
    const envelope = isObject(manifest['envelope']) ? manifest['envelope'] : {};
    const spawn = isObject(envelope['spawn']) ? envelope['spawn'] : {};
    const requires = isObject(manifest['requires']) ? manifest['requires'] : {};
    const provides = isObject(manifest['provides']) ? manifest['provides'] : {};
    if (typeof manifest['name'] !== 'string' || typeof manifest['version'] !== 'string') continue;
    described.packages.push({
      name: manifest['name'], version: manifest['version'],
      scope: spawn['scope'] === 'deployment' ? 'deployment' : 'person',
      internet: spawn['network'] === 'egress',
      needs: Object.keys(requires).slice(0, adminLimits.packages),
      gives: Object.keys(provides).slice(0, adminLimits.packages)
    });
  }
  described.packages.sort((a, b) => a.name.localeCompare(b.name));
  const runtime = isObject(value['runtime']) ? value['runtime'] : undefined;
  if (!runtime) return described;
  if (typeof runtime['model'] === 'string') described.model = { model: runtime['model'], provider: text(runtime['provider']) };
  if (isObject(runtime['mode'])) {
    const deny = Array.isArray(runtime['mode']['deny']) ? runtime['mode']['deny'].filter((value): value is string => typeof value === 'string') : [];
    described.mode = { readOnly: runtime['mode']['readOnly'] === true, deny };
  }
  const options = isObject(runtime['modelOptions']) ? runtime['modelOptions'] : {};
  const limits: Described['limits'] = {};
  if (typeof runtime['maxIterations'] === 'number') limits.maxIterations = runtime['maxIterations'];
  if (typeof options['maxTokens'] === 'number') limits.maxTokens = options['maxTokens'];
  if (typeof options['temperature'] === 'number') limits.temperature = options['temperature'];
  if (Object.keys(limits).length) described.limits = limits;
  if (Array.isArray(runtime['roots'])) {
    const spaces = runtime['roots'].filter(isObject).slice(0, adminLimits.spaces)
      .map(root => ({ path: text(root['path']), mode: root['mode'] === 'rw' ? 'rw' : 'ro', space: text(root['space']) }))
      .filter(root => root.path !== '');
    if (spaces.length) described.spaces = spaces;
  }
  return described;
}

/** Which sections of the control panel have something behind them in this deployment.
 *
 * Computed rather than declared, and recomputed from each `admin.open`, because the answer is a
 * property of the deployment and not of this build: a kernel that withholds `env.logs` has no activity
 * to show, and a `profile.get` that describes no model has no model section. The surface draws this
 * list; a name absent from it is a section a person never sees, which is the whole of "omitted, not
 * stubbed". Kept pure and separate from the sending so it can be tested without a socket.
 */
export function sections(described: Described, offers: (method: string) => boolean, role: string): string[] {
  const open: string[] = [];
  if (described.packages.length) open.push('packages');
  if (described.model) open.push('models');
  if (described.mode) open.push('modes');
  if (described.limits) open.push('limits');
  if (described.spaces) open.push('spaces');
  if (offers('default.prepare') && offers('default.set') && rank(role) >= ranks.reviewer) open.push('updates');
  if (offers('env.status')) open.push('environments');
  if (offers('env.logs')) open.push('activity');
  if (offers('env.reset')) open.push('undo');
  if (offers('snapshot')) open.push('restore-points');
  return open;
}

export class Admin {
  readonly #peer: Peer; readonly #role: string; readonly #send: Send;
  /* The confirmation code `default.prepare` issues never reaches the browser. ADR 0050 §3 says that
   * when one actor makes both calls the code is a nonce and the confirming action is what "explicit"
   * now means, so the code stays here and the page is asked instead to show the digest, the baseline
   * and the gate result and take a distinct second action. Holding it also means a page that never
   * confirms leaves nothing usable behind: it expires on the kernel's own clock. One at a time,
   * because a person is promoting one thing. */
  #confirmation: { digest: string; baseline: number; code: string } | undefined;
  constructor(peer: Peer, role: string, send: Send) { this.#peer = peer; this.#role = role; this.#send = send; }

  #above(minimum: 'reviewer' | 'admin'): boolean { return rank(this.#role) >= ranks[minimum]; }
  #refuse(minimum: 'reviewer' | 'admin'): Result<void> {
    return failure('forbidden', `This account cannot ${minimum === 'admin' ? 'change what everyone gets' : 'review a version'}.`);
  }
  /* A capability this deployment did not negotiate is an answer, not a fault: `wire.ts` established
   * that shape for `env.status`, and every section here follows it so one withheld method costs one
   * missing section rather than a broken panel. */
  #withheld(): Result<void> { return failure('unsupported', 'This part of the control panel is unavailable here.'); }

  async command(input: Contract): Promise<Result<void>> {
    if (input.type === 'admin.open') return this.#open();
    if (input.type === 'admin.setup') return this.#setup();
    if (input.type === 'admin.environment') return this.#environment();
    if (input.type === 'admin.activity') return this.#activity(input);
    if (input.type === 'admin.undo') return this.#undo();
    if (input.type === 'admin.review') return this.#review(input);
    if (input.type === 'admin.confirm') return this.#confirm(input);
    if (input.type === 'admin.add') return this.#add(input);
    if (input.type === 'admin.restore-point') return this.#restorePoint();
    if (input.type === 'admin.tidy') return this.#tidy();
    if (input.type === 'admin.settings') return this.#settings();
    if (input.type === 'admin.accounts') return this.#accounts();
    return failure('unsupported', 'The requested gateway capability is unavailable.');
  }

  async #described(): Promise<Described> {
    if (!this.#peer.supports('profile.get')) return { packages: [] };
    const profile = await this.#peer.call('profile.get', {});
    return profile.ok ? describe(profile.value) : { packages: [] };
  }

  async #open(): Promise<Result<void>> {
    const described = await this.#described();
    return this.#send({ type: 'admin', view: 'open', role: this.#role, sections: sections(described, method => this.#peer.supports(method), this.#role) });
  }

  async #setup(): Promise<Result<void>> {
    return this.#send({ type: 'admin', view: 'setup', ...await this.#described() });
  }

  async #environment(): Promise<Result<void>> {
    if (!this.#peer.supports('env.status')) return this.#withheld();
    const status = await this.#peer.call('env.status', {}); if (!status.ok) return status;
    if (!isObject(status.value)) return failure('protocol', 'The environment returned an invalid status.');
    return this.#send({ type: 'admin', view: 'environment', ...status.value });
  }

  /** The kernel's own observations of this person's environment, which is the only log a gateway may
   *  read: `env.logs` answers exactly what `env.status` would already admit, and reported rows — which
   *  can carry provider content — stay on the other half of the journal (ADR 0014). */
  async #activity(input: Contract): Promise<Result<void>> {
    if (!this.#peer.supports('env.logs')) return this.#withheld();
    const from = typeof input['from'] === 'number' && Number.isSafeInteger(input['from']) && input['from'] >= 0 ? input['from'] : 0;
    const rows = await this.#peer.call('env.logs', { from, limit: adminLimits.logRows }); if (!rows.ok) return rows;
    if (!isObject(rows.value)) return failure('protocol', 'The environment returned invalid activity.');
    return this.#send({ type: 'admin', view: 'activity', ...rows.value });
  }

  /** Rebuilding a person's own environment is theirs to do, so this asks no role above `user`; the
   *  kernel still refuses another person's environment, which is the check that matters. The reply is
   *  a fresh status, because the change the person is watching is exactly what `env.status` reports. */
  async #undo(): Promise<Result<void>> {
    if (!this.#peer.supports('env.reset')) return this.#withheld();
    const reset = await this.#peer.call('env.reset', {}); if (!reset.ok) return reset;
    return this.#environment();
  }

  /** ADR 0050 §3's first half: ask the kernel what it would commit, and answer with the facts a person
   *  has to see before confirming — which version, measured against which baseline. The code the
   *  kernel issues is kept here rather than sent. */
  async #review(input: Contract): Promise<Result<void>> {
    if (!this.#above('reviewer')) return this.#refuse('reviewer');
    if (!this.#peer.supports('default.prepare')) return this.#withheld();
    const digest = typeof input['digest'] === 'string' ? input['digest'] : '';
    const baseline = input['baseline'];
    if (digest === '' || digest.length > adminLimits.digestChars || typeof baseline !== 'number' || !Number.isSafeInteger(baseline)) return failure('invalid-args', 'The version to review is not named.');
    const prepared = await this.#peer.call('default.prepare', { digest, baseline }); if (!prepared.ok) return prepared;
    if (!isObject(prepared.value) || typeof prepared.value['code'] !== 'string') return failure('protocol', 'The environment returned no confirmation.');
    this.#confirmation = { digest, baseline, code: prepared.value['code'] };
    return this.#send({ type: 'admin', view: 'review', digest, baseline, checked: true });
  }

  /** ADR 0050 §3's second half: the distinct confirming action. It must name the same version and
   *  baseline the review answered with, so a page that drifted between the two calls is refused here
   *  rather than committing something the person never saw. */
  async #confirm(input: Contract): Promise<Result<void>> {
    if (!this.#above('reviewer')) return this.#refuse('reviewer');
    if (!this.#peer.supports('default.set')) return this.#withheld();
    const held = this.#confirmation;
    if (!held || input['digest'] !== held.digest || input['baseline'] !== held.baseline) return failure('conflict', 'Look at the change again before confirming it.');
    this.#confirmation = undefined;
    const applied = await this.#peer.call('default.set', { digest: held.digest, baseline: held.baseline, code: held.code }); if (!applied.ok) return applied;
    return this.#send({ type: 'admin', view: 'applied', digest: held.digest, baseline: held.baseline });
  }

  /* `install`, `snapshot` and `prune` exist in `contract/kernel-socket`'s method enum, but they are the
   * evaluation runtime's run, score and release (`lib/evaluation/runtime.ts`) — bound to the designated
   * deployment-scope evidence source, and nothing a person means by those words. There is no method on
   * this socket that adds a package or keeps a restore point, so `service.ts` asks for none of the
   * three and these three commands answer `unsupported`, which leaves their sections out. The role gate
   * is written anyway, because it is the half that does not depend on the capability arriving: adding
   * something everyone gets is an administrator's, whichever method eventually carries it. */
  #add(input: Contract): Promise<Result<void>> {
    if (input['scope'] === 'deployment' && !this.#above('admin')) return Promise.resolve(this.#refuse('admin'));
    return Promise.resolve(this.#withheld());
  }
  #restorePoint(): Promise<Result<void>> {
    if (!this.#above('admin')) return Promise.resolve(this.#refuse('admin'));
    return Promise.resolve(this.#withheld());
  }
  #tidy(): Promise<Result<void>> {
    if (!this.#above('admin')) return Promise.resolve(this.#refuse('admin'));
    return Promise.resolve(this.#withheld());
  }
  /* Legacy's control panel rendered from what the kernel described — a setting arrived with its type,
   * its help and its source, and a new setting needed no UI change. This kernel has no described-field
   * capability and no write path for one: `profile.get` answers a target's own record with no field
   * descriptions, and nothing on this socket writes it back. Rather than show a settings form that
   * cannot save, the section is left out and this command says so. */
  #settings(): Promise<Result<void>> {
    if (!this.#above('admin')) return Promise.resolve(this.#refuse('admin'));
    return Promise.resolve(this.#withheld());
  }
  /* Nothing on this socket lists the people a deployment knows: `session.whois` and `token.whois`
   * resolve one credential the caller already holds, and `hello` names only the person connected.
   * An accounts section that could show one row — yourself — is not an accounts section. */
  #accounts(): Promise<Result<void>> {
    if (!this.#above('admin')) return Promise.resolve(this.#refuse('admin'));
    return Promise.resolve(this.#withheld());
  }
}
