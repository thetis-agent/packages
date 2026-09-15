# @thetis/gateway-login

The sign-in page: the one place a password becomes a token. It runs as a service in the system userspace fence, the only fence the kernel lets log people in, and listens on that userspace's `run/login.sock`. The door routes `/login`, `/logout`, and `/` to it. It exchanges a password for a token, sets the cookie every person's gateway checks, and sends the browser to `/<person>/`. It never serves a conversation.

## What it provides

The manifest declares `type: gateway` and a `service` whose export is `startService`. No steps, no tools, no ui. The default configuration installs it into the system userspace (`systemPackages._system`), so `thetis serve` starts it.

| Route | Effect |
|---|---|
| `GET /login` | The sign-in page. |
| `POST /login` | Form fields `id`, `password`, `next`. Calls `auth.login`. On success sets the cookie and redirects to `next` when it is inside `/<id>/`, else to `/<id>/`. On failure redirects to `/login?error=refused`. |
| `POST /logout` | Calls `auth.logout`, clears the cookie, redirects to `/login`. |
| `GET /` | Redirects to `/<person>/` with a valid cookie, else to `/login`. |
| `GET /login/assets/<file>` | The page's own files. |

A request with `Content-Type: application/json`, or an `Accept` that includes it, gets a JSON answer instead of a redirect. The cookie is `thetis_web`, `HttpOnly`, `SameSite=Strict`, `Path=/`, 30 days, and `Secure` when configured so. The body is limited to 64 KiB. The HTML is served with a Content Security Policy that allows only same-origin scripts and styles.

The service sees a password once, on its way to the kernel. The kernel holds the credentials in `$THETIS_HOME/auth.json`, which no fence can read.

## Configuration

`config.packages["@thetis/gateway-login"]`:

| Key | Default | Meaning |
|---|---|---|
| `secure` | `false` | Adds `Secure` to the cookie. Set it when TLS terminates in front of the door. |

## Use

```sh
thetis users add alice
thetis users passwd alice --password secret   # or: echo secret | thetis users passwd alice
thetis serve                                   # the door, the login target, and one gateway per person
```

Open `http://127.0.0.1:8777/login`. An existing deployment that does not have it yet gets it with `thetis install @thetis/gateway-login`, which installs into the system userspace.

The server is also a function, for an in-process host or a test:

```ts
import { createLogin } from "@thetis/gateway-login";

const server = createLogin(kernel, { secure: false });
```

`kernel` is a `KernelClient`; the service passes `env.kernel`.

## Files

| File | Content |
|---|---|
| `src/index.ts` | `startService(env)`: listens on `run/login.sock`, mode `0660`, and returns `{ stop }`. `stop` closes every open connection. |
| `src/server.ts` | `createLogin(kernel, { assets?, secure?, log? })`: the routes, the cookie, the form and JSON bodies, the assets. |
| `assets/` | `login.html`, `login.css`, `login.js`, `theme.css`, `favicon.svg`. Plain files, no build step. |

## Tests

The package has no tests of its own; its `test/` directory is empty. `packages/gateway-web/test/gateway.test.ts` runs the login target behind a door: login refused and accepted, `next` kept inside the person's prefix, a suspended person, a password change, and logout; its last case installs this package into the system userspace and drives the same path through a real fence. Run every test with `npm test` from the runtime root.

See docs/15-web-gateway.md in the runtime repository.
