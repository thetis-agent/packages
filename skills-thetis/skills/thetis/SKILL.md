---
name: thetis
description: The index of Thetis, the service you run inside: the words to use with a person, how a change takes effect, and which thetis/* child skill to fetch. Use when you work on or explain Thetis, write or install an extension, or do not know which child skill answers a question.
metadata:
  title: Thetis
  tags: [thetis, overview, glossary, words, extensions, packages, updates, restart, retry, space, kernel, pipeline, fence, userspace, skills, index]
  related: [thetis/using, thetis/packages, thetis/pipeline, thetis/troubleshooting]
  version: 1
---
# Thetis

Thetis is a multi-user assistant service, and you are the assistant inside it. Each person has their own space on the server: their files, their chats, and the extensions installed for them. Everything that makes Thetis useful is an extension: your tools, your skills, the web page and the model providers. You can build and install an extension from a conversation. It takes effect when this reply ends.

## Words to use with the person

Use these words. They are the words the page uses. The words in the last column are for code and for package authors. Do not use them with a person unless they ask how Thetis works inside.

| Say | Means | Internal names |
|---|---|---|
| chat | one conversation | session |
| reply | one answer of yours, with the tools it ran | turn |
| helper chat | a chat you start to do part of the work | subagent, child session |
| project | a group of chats with its own instructions and folders | project |
| your space | the person's area on the server: files, chats, extensions | userspace, fence |
| workspace | a person's space, on the admin's pages only | userspace, fence |
| Files, Home | the Files place, and the person's own folder in it, where you work | ui-workspace, home, `env.cwd` |
| server folders | directories an admin shared into the person's space | mounts |
| extension | something installed that adds tools, skills, a page, or a model provider | package |
| your copy | the person's own copy of an extension, used instead of the official version | fork |
| Switch back to the official version | stop using the copy; its files stay | unfork |
| Make it the default for everyone | an admin gives an extension to every person, now and later | promote, install for everyone |
| Extensions | the place where extensions are found, installed, updated and set up | marketplace, ui-marketplace |
| extension settings | the Configure form on an extension's page | package config, config layers |
| registries | where the installation gets extensions from (admin) | registries |
| Up to date, Update ready, Restart needed | the three states of new code | loaded version, behind, stale |
| Update, Update all, Apply | put new code into service: the space starts again for a few seconds, and the chats are kept | install, fence reload |
| Retry, Continue | carry a reply on from where it stopped | resume, a turn with no input |
| Update and restart, Restart Thetis | an admin puts new code of Thetis's own core into service | daemon restart |
| Control panel | Overview, People, Extensions, Models, Access, Activity, Account, Advanced | ui-admin sections |

## How a change takes effect

There are three answers. Find the one that applies before you say anything.

1. **Live on the next message.** A changed tool, skill, step, UI command, manifest, or extension setting, and any file one of those imports. Nothing to do. A changed file of the page itself shows after the page refreshes.
2. **Applied by itself when no reply is running.** A background service, a provider, and every extension you install, copy or edit in this reply: it takes effect when this reply ends. The person's page applies it once nothing runs and says "Applied your changes to moo". When a terminal is open, or the person chose to be asked, the page shows **Changes ready** with **Apply**. New code for the extensions the installation ships shows as the **Updates ready** card, with **Update all**. Tell the person what changed. There is nothing for them to type, and no reload to ask for.
3. **Restart Thetis.** Only for Thetis's own core. An admin uses **Update and restart** on the Control panel's Overview, or **Restart** when the card says "Restart to finish". Every running reply pauses at a safe point and continues by itself when Thetis is back. It is never the answer for an extension. If a feature seems to need a restart, it is in the wrong extension.

A reply that stops before its end is not lost. A dropped connection is sent again by itself. When those tries run out, the reply ends in one row with a **Retry** button, and a reply the person stopped ends with **Continue**. A reply that a restart, an update or a crash cut short continues by itself. Never ask the person to type "continue". See `thetis/troubleshooting`.

## The one rule

Thetis's core has no features. It knows people, their spaces, chats, and extensions. To add a capability, write an extension. Do not ask for a core change.

## Skills to fetch

A brief is a pointer, not the content. Call `skill_fetch` with the id before you rely on a skill.

| Id | Fetch when |
|---|---|
| `thetis/using` | You need chats and helper chats, the shell, the file tools, the plan tools, `ask_user`, the home layout, where standing notes go, or how a restart of Thetis goes. |
| `thetis/packages` | You write, install, copy, switch back, publish, or remove an extension, or you need the manifest shape. |
| `thetis/pipeline` | You write a step, an enumerator, or state in `harness`, or you must keep the prompt cache warm. |
| `thetis/skills` | You write a skill, lint one, or need to know where skills come from and how loaders show them. |
| `thetis/projects` | A chat belongs to a project, or a tool or folder is switched off or not shared. |
| `thetis/marketplace` | You install from a registry, update an extension, or need the Extensions place, the index and README paths. |
| `thetis/web` | You add a dock, a place, a panel section, a chip, a notice, or a command to the web page. |
| `thetis/bench` | You opt a package into a benchmark suite, run one, or read a report. |
| `thetis/configuration` | You need an extension setting, a server setting, a field of `thetis.config.json`, or a secret. |
| `thetis/fence` | A path is read-only or hidden, the network is refused, or a limit is hit. |
| `thetis/troubleshooting` | A reply stopped, a step throws, a tool is refused, an install fails, a change is not live, a restart was refused, or you need the logs. |
| `thetis/developing` | You change the runtime itself, on the host, not a package in a space. |

## How Thetis works inside

For package authors, and for a person who asks. A person's space is a *userspace*. All of its package code runs in one process, the *userspace agent*, inside a sandbox called the *fence*. The *kernel* is the only bridge between a fence and the host, and it has no opinions: it knows users, userspaces, sessions, the pipeline, the three variables (`conversation`, `call`, `harness`), and packages. A *turn* is one pass through the pipeline of steps, and every step is package code.

The page words map to these mechanisms:

- **Apply** and **Update all** are a *fence reload*: the fence closes and opens again on the code on disk. It has three modes. `idle` refuses while a turn runs. `drain` asks each running turn to stop at its next round boundary (`turns.yielding()`), waits, then cancels the rest. `force` cancels at once. Every browser surface sends `drain`.
- **Restart Thetis** arms the *daemon's restart latch*. It drains every turn the same way, counts down where everyone can see it, and exits so that systemd starts it again.
- **Retry**, **Continue**, the automatic resume, `resume_subagent` and the workflows engine are all one *resume*: `sessions.send(id, [])`, a turn with no input over the saved conversation. The record says why the last turn stopped in `session.interrupted.why`.
- **Your copy** is a *fork*; **Switch back** is *unfork*; **Make it the default for everyone** is *promote* or *install for everyone*.

The long form of each is in the child skills.

## Sources

- README.md and each package's own README.md
- src/kernel/kernel.ts, src/host/kernel.ts, src/kernel/control.ts
- packages/gateway-web/README.md, packages/ui-marketplace/README.md, packages/ui-admin/README.md
- packages/harness-core/README.md
- packages/skills-thetis/skills/thetis/ for the rest of this set
