# @thetis/tool-operator

The operator's own package: one tool that asks this daemon to restart itself, and the status-bar chip that shows a restart coming and calls it off. It is a `tool` package with a `ui`, plain ECMAScript with no build step, no dependency and no `bench` block. It adds nothing to the kernel and holds no state: every guard is the kernel's, and every sentence it returns is written in `@thetis/runtime/lib/restart` and passed through untouched.

It exists as a package of its own because **authority here is what is installed**. A tool declaration carries no `role` field, unlike a `ui.commands` entry, so a tool that every model can see and only an admin may use would be a setting that records an intention: the model would offer the tool to everyone and collect refusals. Instead this package is installed for one admin at a time:

```
thetis packages install @thetis/tool-operator --user <id>
```

or as a per-user key in `systemPackages`. **It must never go into `systemPackages["*"]`.** That is the whole authority model: a person who is not meant to restart this installation never sees a tool that restarts it, and the model that answers them is never given one. It is also deliberately not part of `@thetis/tool-exec`, which everyone has and which is benched — an admin-only tool in a benched package would change everyone's numbers.

The packaging is the signal, not the guard. The kernel asserts the admin role on `restart.request` itself, so installing this package for somebody who is not an admin gives them a tool that answers with a refusal, not a restart.

## What it provides

The manifest declares `type: "tool"`, one `tool`, and a `ui` block with `dir: "ui"`, `entry: "index.js"`, `style: "index.css"`, one `statusbar` entry and three commands. No `role` appears anywhere in it, because nothing here needs one.

| Tool | Arguments | Answer |
|---|---|---|
| `restart_daemon` | `reason` (required) | The latch's own sentence, verbatim. On an armed restart, one added instruction: say it now, in this reply. |

`reason` is the only parameter. The deadline is configuration, not a per-call argument, and there is no `confirmed` flag: the model would be the one setting it, which makes it a lie in a schema. What stops a surprise is the design — the turn finishes before the latch can fire, so the reply is the announcement, and there is a real countdown with a Cancel button on the page and `thetis restart cancel` on the host.

**The tool never restarts anything.** It asks the kernel to arm a latch, and the latch waits until no turn is running anywhere, counts down where everyone can see it, and then resolves the same promise `SIGINT` resolves, so the ordinary shutdown path runs and `Restart=always` turns the clean exit into a restart.

| Slot | Id | Order |
|---|---|---|
| `statusbar` | `restart` | 90 |

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `restart-status` | `uiStatus` | none | `RestartState`: whether one is armed, and whether one would be accepted at all. |
| `restart-cancel` | `uiCancel` | none | `{ cancelled, was }`, and the sentence. Nothing armed is said plainly, not raised as a failure. |
| `restart-now` | `uiRestart` | `reason` | The `ArmResult`, and its `message` as the text. A reason is required here too. |

The first two are what the chip sends. `restart-now` is declared, implemented and tested, and **this package draws no button for it**, because the one surface it owns — the status-bar entry — is hidden whenever nothing is pending, which is exactly when a restart would be armed. The seam is there for a page that wants it; today an admin arms a restart with `thetis restart` on the host, or through the model. That is a gap, and it is written down here rather than papered over with a control that only looks like one.

## The guards, and what each refusal means

Every one of these is enforced in the kernel or the latch, never here, and each answers with its own sentence. **A refusal means nothing happened** — that is the last sentence of every one of them, and it is what stops a model inventing a second attempt.

| `why` | What it means | What to do instead |
|---|---|---|
| — | Not an admin. The kernel throws `unauthorized`; this package turns it into one plain sentence and never a stack trace. | An admin restarts, from the control panel or `thetis restart` on the host. |
| — | No reason. Refused here, before the kernel is asked: a restart nobody can account for is not sent on. | Say what changed and why a reload cannot pick it up. |
| `off` | `control.allowRestart` is false: this installation withholds restarts entirely. | Reload a workspace, or ask the operator at the host. |
| `unsupervised` | systemd did not start this daemon, so exiting would stop Thetis rather than restart it. | Restart it by hand at the host, or reload the workspace. |
| `no-listener` | The process is a short-lived command — `thetis send`, `thetis chat`, the bench — not the serving daemon, so a restart would only kill the command. | Ask for it in the running installation. |
| `young` | The daemon has been up less than `control.minUptimeSecs` (60 by default). It is what makes "restart → it did not help → restart" terminate. | Wait, and look for the real fault: another restart will not find it. |
| `policy` | The deployed unit says `Restart=` something other than `always`, or it could not be read. A clean exit would stay down. | Only the operator can fix the unit, at the host. |

`again` is a distinct answer, not a failure: a restart is already armed, asking again neither delayed it nor armed a second one, and there is nothing to fix. The tool says so and adds nothing.

Two things about the deadline are stated in the tool's description rather than hidden, because they are what the model has to tell the person: it waits for **every** conversation everywhere to go quiet before it counts down, and if a turn is still running two minutes later it restarts anyway and cuts that turn off. Conversations come back with their history; open terminal shell sessions do not, and whatever was running in one dies with them.

## The chip

`Restart pending · 8s`, at order 90 in the status bar, with the reason and who asked in its title and a **Cancel** button behind a confirm popover. It is **hidden entirely when nothing is pending**: a status bar saying that no restart is armed is noise, and the thing worth a permanent line — whether the running code is stale — belongs to the control panel's Workspaces section. It exists only for admins, and nothing in it checks a role: the package is installed per admin, so the gateway never lists this extension for anyone else.

It polls `restart-status` every 3 s, and every 700 ms while something is pending.

Then the daemon goes, and **the page must recover or say why**. The restart is a process exit, so the gateway serving the page goes with it and the poll stops answering. A failed poll while a restart was armed is read as the restart happening, not as a fault: the chip says `Restarting · waiting for Thetis · 12s` and keeps trying for **90 seconds** — an exit, systemd's `RestartSec=2`, a fresh kernel, every fence reopening and every service booting, which is far longer than the 30 seconds a fence reload needs. At the deadline it stops and says

> Thetis has not come back. It may have failed to start — check journalctl -u thetis-runtime.

A spinner that never resolves is the failure this project keeps deleting, so the deadline is real, the sentence names the command that finds the answer, and the chip is then a button a person can press once they have looked. A failed poll with **nothing** armed says nothing about a restart, so the chip stays hidden and the poll simply carries on.

The page's Content Security Policy allows no inline styles, so everything the chip draws is a class in `ui/index.css`.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: one tool, one status-bar entry, three commands. No `bench`, no dependency. |
| `index.js` | The tool and the three commands, over `env.kernel.operator.call`. Argument checks, and the three sentences this package owns. |
| `ui/index.js` | `install(ext)`: the chip, the poll, and the ninety-second recovery. |
| `ui/index.css` | The chip and its Cancel button, in a 26px bar. |
| `test/tool.test.js` | The tool and the commands against a fake operator. |
| `test/chip.test.js` | The chip against a fake seam, with the clock moved so the deadline is tested in under a second. |

## Tests

`npm test` from the runtime root, or `node --test "test/*.test.js"` here. `test/tool.test.js`: every `ArmResult` state comes back byte for byte, an armed one carries the instruction to say it now, a missing or blank reason is refused before the kernel is asked, a trimmed reason is the only argument sent, a thrown `unauthorized` becomes the plain sentence, any other failure is not swallowed, and the manifest declares what this README says it does. `test/chip.test.js`: hidden while nothing is pending, the countdown and the Cancel button, both branches of the deadline in the title, the daemon going and the page waiting, and the waiting really ending.

See `src/lib/restart.ts` in the runtime repository for the whole restart feature, and `src/kernel/packages/manifest.ts` for the one package deliberately not installed for everyone.
