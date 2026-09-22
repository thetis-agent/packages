---
name: thetis
description: The index of Thetis, the service you run inside: its one rule and which thetis/* child skill to fetch. Use when you work on or explain Thetis, write or install a package, or do not know which child skill answers a question.
metadata:
  title: Thetis
  tags: [thetis, overview, kernel, packages, pipeline, fence, userspace, skills, index]
  related: [thetis/using, thetis/packages, thetis/pipeline, thetis/troubleshooting]
  version: 1
---
# Thetis

Thetis is a multi-user language model service, and you are the model inside it. Each person has one fenced userspace, and all package code runs inside that fence. Each turn runs a pipeline of steps, and a step can change `conversation`, `call`, or `harness`. You can change how Thetis works from a conversation: write a package, install it, and it is live on the next turn. The kernel is the only bridge between a fence and the host.

## The one rule

The kernel has no opinions. It knows users, userspaces, sessions, the pipeline, the three variables, and packages. Everything else is a package: prompts, tools, memory, providers, gateways, skills. To add a capability, write a package. Do not ask for a kernel change.

## Skills to fetch

A brief is a pointer, not the content. Call `skill_fetch` with the id before you rely on a skill.

| Id | Fetch when |
|---|---|
| `thetis/using` | You need sessions, subagents, the shell session tools, the file tools, the plan tools, `ask_user`, the home layout, or where standing notes go. |
| `thetis/packages` | You write, install, fork, promote, or remove a package, or you need the manifest shape. |
| `thetis/pipeline` | You write a step, an enumerator, or state in `harness`, or you must keep the prompt cache warm. |
| `thetis/skills` | You write a skill, lint one, or need to know where skills come from and how loaders show them. |
| `thetis/projects` | A conversation belongs to a project, or a tool or directory is switched off or not mounted. |
| `thetis/marketplace` | You install from a registry, update a package, or need the index and README paths. |
| `thetis/web` | You add a dock, a place, a panel section, a chip, or a command to the web page. |
| `thetis/bench` | You opt a package into a benchmark suite, run one, or read a report. |
| `thetis/configuration` | You need a field of `thetis.config.json`, per-package config, or a secret. |
| `thetis/fence` | A path is read-only or hidden, the network is refused, or a limit is hit. |
| `thetis/troubleshooting` | A step throws, a tool is refused, an install fails, a service does not start, or you need the logs. |

## Sources

- README.md and each package's own README.md
- packages/kernel/src/kernel.ts, packages/host/src/kernel.ts
- packages/skills-thetis/skills/thetis/ for the rest of this set
