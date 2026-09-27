# @thetis/tool-operator

The operator's own package: one tool that asks this Thetis server to restart itself. It is a `tool` package, plain ECMAScript with no build step, no dependency, no page and no `bench` block. It adds nothing to the kernel and holds no state: every guard is the kernel's, and every sentence it returns is written in `@thetis/runtime/lib/restart` and passed through untouched, apart from the few this package owns (below).

It used to draw a status-bar chip with the countdown and a Cancel button, for admins only. That moved out in 0.2.0: gateway-web shows the countdown to everyone ("Thetis restarts in 20 s · your reply will continue"), and an admin calls a restart off with **Cancel** on the control panel's **Overview** (or **Advanced › Workspaces**).

It exists as a package of its own because **authority here is what is installed**. A tool declaration carries no `role` field, unlike a `ui.commands` entry, so a tool that every model can see and only an admin may use would be a setting that records an intention: the model would offer the tool to everyone and collect refusals. Instead this package is installed for one admin at a time:

```
thetis packages install @thetis/tool-operator --user <id>
```

or as a per-user key in `systemPackages`. **It must never go into `systemPackages["*"]`.** That is the whole authority model: a person who is not meant to restart this installation never sees a tool that restarts it, and the model that answers them is never given one. It is also deliberately not part of `@thetis/tool-exec`, which everyone has and which is benched — an admin-only tool in a benched package would change everyone's numbers.

The packaging is the signal, not the guard. The kernel asserts the admin role on `restart.request` itself, so installing this package for somebody who is not an admin gives them a tool that answers with a refusal, not a restart.

## What it provides

The manifest declares `type: "tool"` and one `tool`. No `role` appears anywhere in it, because nothing here needs one.

| Tool | Arguments | Answer |
|---|---|---|
| `restart_daemon` | `reason` (required) | The latch's own sentence, verbatim. On an armed restart, one added instruction: this reply pauses too, so say in this same message, before anything else, what is restarting and why, and do not ask the person to continue. |

`reason` is the only parameter. The deadline is configuration, not a per-call argument, and there is no `confirmed` flag: the model would be the one setting it, which makes it a lie in a schema. What stops a surprise is the design: a real countdown everyone can see, a **Cancel** for admins on the control panel's **Overview**, and `thetis restart cancel` on the host.

**The tool never restarts anything.** It asks the kernel to arm a latch. The latch asks every running turn, the caller's included, to pause at its next safe point (a round boundary), waits for them for two minutes at most, counts down where everyone can see it, and then resolves the same promise `SIGINT` resolves, so the ordinary shutdown path runs and `Restart=always` turns the clean exit into a restart. A turn still inside a long tool call at the deadline is cut there and saved. Paused and cut turns continue by themselves when Thetis is back (`@thetis/harness-core`'s resumer), so the model is told not to ask anybody to type "continue".

**While an update is installing, the tool refuses** before it asks the kernel:

> An update is installing; Thetis restarts by itself when it is done. Nothing was armed by this call, so do not ask again.

It asks `host.update.progress` first, and refuses when `@thetis/host-update`'s record says `running`, which it says only while the update job holds its lock. A restart in that window would load a half-installed checkout, and the update restarts Thetis itself when it is done. Any failure to ask (no `@thetis/host-update`, an older kernel) is read as "no update is running", and the kernel's own guards still apply.

## The guards, and what each refusal means

Every one of these is enforced in the kernel or the latch, never here, and each answers with its own sentence. **A refusal means nothing happened** — that is the last sentence of every one of them, and it is what stops a model inventing a second attempt.

| `why` | What it means | What to do instead |
|---|---|---|
| — | Not an admin. The kernel throws `unauthorized`; this package turns it into one plain sentence and never a stack trace. | An admin restarts from the control panel: **Update and restart** or **Restart** on **Overview**, or **Restart Thetis…** under **Advanced › Workspaces**; on the host, `thetis restart`. |
| — | No reason. Refused here, before the kernel is asked: a restart nobody can account for is not sent on. | Say what changed and why only a restart picks it up. |
| — | An update is installing. Refused here, before the kernel is asked. | Nothing: the update restarts Thetis when it is done. |
| `off` | `control.allowRestart` is false: this installation withholds restarts entirely. | Ask the operator at the host. An extension never needs a restart: its changes apply when the reply ends. |
| `unsupervised` | systemd did not start this daemon, so exiting would stop Thetis rather than restart it. | Restart it by hand at the host. For an extension, nothing: its changes apply when the reply ends. |
| `no-listener` | The process is a short-lived command — `thetis send`, `thetis chat`, the bench — not the serving daemon, so a restart would only kill the command. | Ask for it in the running installation. |
| `young` | The daemon has been up less than `control.minUptimeSecs` (60 by default). It is what makes "restart → it did not help → restart" terminate. | Wait, and look for the real fault: another restart will not find it. |
| `policy` | The deployed unit says `Restart=` something other than `always`, or it could not be read. A clean exit would stay down. | Only the operator can fix the unit, at the host. |

`again` is a distinct answer, not a failure: a restart is already armed, asking again neither delayed it nor armed a second one, and there is nothing to fix. The tool says so and adds nothing.

Two things about the deadline are stated in the tool's description rather than hidden, because they are what the model has to tell the person: every running conversation, the caller's included, pauses before the countdown, and a turn still inside a long tool call two minutes later is cut there. Both kinds continue by themselves when Thetis is back; open terminal shell sessions do not, and whatever was running in one dies with them.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: one tool. No page, no `bench`, no dependency. |
| `index.js` | The tool, over `env.kernel.operator.call`. The argument check, the update-lock check, and the sentences this package owns. |
| `test/tool.test.js` | The tool against a fake operator. |

## Tests

`npm test` from the runtime root, or `node --test "test/*.test.js"` here. `test/tool.test.js`: every `ArmResult` state comes back byte for byte, an armed one carries the added instruction, a missing or blank reason is refused before the kernel is asked, a trimmed reason is the only argument sent, a thrown `unauthorized` becomes the plain sentence, any other failure is not swallowed, a running update refuses before `restart.request` is sent (for both record shapes host-update has answered with), an update that is not running or a missing host package does not stand in the way, and the manifest declares what this README says it does.

See `src/lib/restart.ts` in the runtime repository for the whole restart feature, and `src/kernel/packages/manifest.ts` for the one package deliberately not installed for everyone.
