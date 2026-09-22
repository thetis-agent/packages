# @thetis/package-publish

Publishing a package is its own act and not a side effect of saving one. A registry is a git repository, each package a directory in it with a `package.json` that has a `thetis` field, and `@thetis/marketplace` pins what it finds as `<url>#<dir>@<commit>`. So publishing is exactly: put the package's directory in the registry repository at a new version, commit, push. Nothing else makes a new version visible to anybody, and a version that does not move past what the registry already holds is invisible to every update check there is. Removal is the same sentence backwards: delete the directory, commit, push.

It is a `tool` package, so it runs in the person's own fence with the person's own agent-held ssh key: the registry's own authentication decides who may publish, and this package decides nothing about that. It is plain ECMAScript with no build step and no dependencies.

## What it provides

Three tools, declared in `thetis.tools`, all answering an object:

| Tool | Arguments | Returns |
|---|---|---|
| `publish_package` | `package` (required, an installed name or a path), `to`, `version` or `bump` (`patch`, `minor`, `major`), `as` (`origin` or `itself`, for a fork), `with` (names of other packages riding on the branch that you mean to publish too), `message`, `dryRun` | The whole act as fields: `package`, `target`, `url`, `branch`, `directory`, `mode`, `as`, `forkedFrom`, `fork`, `was`, `now`, `first`, `files`, `commit`, `committed`, `pushed`, `author`, `verify`, `source`, `indexed`, `others`, `nameable`, `with`, `summary`, `journals`, `records`, and on a dry run `ok` and `blockers`. |
| `unpublish_package` | `package` (required, the name a registry holds it under or the directory it keeps it in), `to`, `with`, `message`, `dryRun` | The same fields where they mean the same thing, `removed: true`, and `held` (the version the registry was carrying) in place of `was`, `now` and `first`. |
| `publish_targets` | `package` (optional) | `workDir`, `defaultTarget`, `package` (with its `problem` when the manifest is unsound), and `targets[]`: `name`, `url`, `branch`, `repo`, `cloned`, `lastPublish`, `lastRemoval`, and with a package `directory`, `holds`, `first`, `ahead`, `error`. |

The mechanism is the library under `lib/`, as plain functions over `(args, env)`; the tool exports are thin wrappers that coerce what a model sends. Both halves are exported from `index.js`, so a caller in the same fence can reach `publish` and `targets` directly instead of going through `env.invokeTool`:

| Export | Use |
|---|---|
| `publish(args, env)`, `unpublish(args, env)`, `targets(args, env)` | The library. The tool exports call these and add nothing. **Another package should still come through `env.invokeTool`**: `env.storage` is namespaced by the kernel under the *calling* package's name, so a direct import would look for this package's records under that package's namespace and quietly find an empty store. The direct import is for code in this package's own fence context. |
| `publishPackage(args, env)`, `unpublishPackage(args, env)`, `publishTargets(args, env)` | The tool exports the manifest names. |
| `sameRepository(a, b)`, `repoKey(url)` | Two git urls compared as repositories. |
| `compareVersions(a, b)`, `bumpVersion(v, how)`, `isVersion(v)` | The version rules, written out because a fence installs no dependencies. |
| `pickTarget(config, to)`, `targetsOf(config)`, `workDirOf(env, config)` | The configuration, as the rest of the package reads it. |
| `lastPublish(env, target)`, `lastRemoval(env, target)` | The last publish to, and the last removal from, one target, out of the package's own store. Two keys and not one with a flag on it: a card that drew a version from both would report a package's removal as its current version. |
| `forkedFrom(manifest)` | The origin a manifest names, or null. |
| `Refusal` | Every refusal this package throws. `err.code` is the machine-readable half. |

No steps, no service, no UI, no bench suites.

## The two sources

Both are supported and the package tells them apart by looking, not by being told:

| Source | How it is recognised | What happens |
|---|---|---|
| A userspace package, `<home>/packages/<slug>`, which is not a git repository | Everything that is not the other case | The target is cloned into `<home>/<workDir>/<target>` (fetched and reset when the clone is already there), the package's directory is copied in at the name the target already uses for it, or its own directory name when it is new, and the clone is committed and pushed. |
| A package inside a checkout that is already the target repository | The resolved package path is inside a git work tree whose `origin` is the same repository as the target's url | Nothing is cloned and nothing is copied. Only that package's directory is committed, in the checkout, and the branch is pushed. |

The second case is the maintainer's. Their `packages/` directory is four things at once: the shipped package source, their git work tree, their installation's marketplace registry, and the push origin the rest of the world's Thetis installations trust. It is also where a commit most easily ends up spanning half a tree, which is what the `-- <directory>` on the commit and the staged-files gate are for.

**Scoping the commit does not scope the push.** `git push` sends the branch, so a branch that is already carrying commits to other packages carries them to the registry however carefully this package commits. It cannot be fixed by committing better, and it is not rare: committing as you go across several packages and then shipping one is the maintainer's normal rhythm, so the committed state is the common state.

Neither obvious answer works. Refusing on every passenger costs a branch dance often enough that the tool gets routed around with a plain `git push`, which is the behaviour this package exists to stop, and a gate people bypass is worse than no gate. Letting a passenger ride because its version moved reads consent into a version bump, and a person bumps a version to try something as readily as to ship it. So consent is asked for instead, by name, and it is one argument:

| A passenger that is | What happens |
|---|---|
| not publishable on its own: its version has not moved past what the registry holds, its manifest is unsound, or the registry holds its directory under another name | Refused, always, and it can never be named in `with`. Its code would land under a version every installation already holds and no update check will look at again. The refusal gives the procedure that works: put the commits aside and bring one package back at a time. |
| publishable, and not named in `with` | Refused, and listed as nameable, with the command that names it. Nothing ships that nobody asked for. |
| publishable, and named in `with` | It rides, and it is a publish in its own right: every gate the named package gets, `verify` included, its own row in `answer.journals`, its own record, and its own full result in `answer.with`. |
| named in `with` but not actually riding | Refused. A name that quietly does nothing is worse than a name that is wrong. |

`git@github.com:o/r.git`, `https://github.com/o/r.git`, `https://github.com/o/r`, `ssh://git@github.com:22/o/r.git` and `git://github.com/o/r.git` are all one repository. `file:///srv/reg.git` and `/srv/reg` are one repository. A host is never the same repository as a local path.

## A fork is two publishes, so it is asked which

`fork_package` copies a package and writes `thetis.forkedFrom` into the copy: the name and the version it was taken from. So "publish my change", said over a fork, is two entirely different acts wearing the same words.

It can mean **the change becomes the next version of the package it came from**, which is upstreaming and the reason most people fork at all. Or it can mean **this is a package of its own now**, deliberately apart from the one it came from. Both are legitimate, so the answer is not to pick one.

Guessing was the old behaviour and it looked like it worked. A fork published under its own name made the registry quietly grow a second package: `widget` holding `@dev/widget 0.1.0` and `widget-mine` holding `@dev/widget-mine 0.2.0`. The change went out under a name nobody installs, un-forking put the person back on the old code, and nothing said a word. The loop did not close.

So `as` says which, and the refusal names both ways out and prints the command for each:

| `as` | What lands in the registry | What happens here |
|---|---|---|
| `origin` | The origin's `name`, the version being published, and **no `forkedFrom`**, in the origin's own directory. What lands is the origin, not a copy of it: a registry entry carrying `forkedFrom` would displace the very package it is in every userspace that took it. | Nothing. The person's copy keeps its own name, its own `0.1.0-fork.1` version and its own `forkedFrom`, and goes on being their fork. |
| `itself` | The fork, under its own name, in its own directory, `forkedFrom` and all. This is what happened before, and it is right whenever divergence is the intention. | Nothing beyond an ordinary publish: the version is written into the fork's manifest as usual. |

**The question is asked once.** The gate fires when the target holds the origin and does not yet hold this fork. Once the fork is in the registry under its own name, a publish has only one reading left, and asking again every time would be a setting that records an intention rather than a state; the registry is the state, and it is the thing that remembers.

**The gates are not the same for the two.** As its origin, the version has to move past what the target holds **for the origin**, and the fork's own `0.1.0-fork.1` is never a candidate and never the default: a `patch` step from it is `0.1.0`, which is the version the registry already holds. A step is taken from what the target holds for the origin, or, when the target holds none, from the version the fork was taken at. And `name-mismatch` keeps protecting the accident while permitting this, because an as-origin publish is aimed at the origin's own directory: that directory holding the origin is what makes it right, and a directory holding some third package is refused exactly as before.

The checkout case is not asked at all. A package inside the registry repository is kept in the directory it already sits in, so a publish there has one thing it can be; `as origin` from inside a checkout is refused rather than rearranging somebody's work tree for them.

## Removal

`publish` only ever adds and updates. A package published by mistake, or retired, stayed in the index for ever, and `thetis packages uninstall` takes one off a person and touches no registry. `unpublish_package` is the other half: delete the package's directory, commit it, push.

It is a tool and a verb of its own rather than an argument to `publish_package`, deliberately. An argument that inverts what a command does is how people delete things by accident: it is one word away from a publish in a shell history, in a retry after a typo, in a model's second attempt at a call it got wrong the first time. The two acts also share almost no arguments -- there is no version, no step, no `verify` and nothing to copy. What they do share is the branch, and that is shared as code, in `lib/passengers.js`.

The gates are the ones that still mean something. The target has to actually hold it, under that name or in that directory. The three gates about the state of the tree apply unchanged, because a removal commits one directory and pushes a branch exactly as a publish does, and the branch is carrying whatever it was carrying before anybody typed this; `with` works the same way, and a package named in it is a publish in its own right riding alongside a removal.

The package to remove is named, not resolved: it does not have to be installed here, because a package published by mistake is often one nobody kept. A local copy is looked for all the same, and only for one thing -- the case where the package is inside a checkout that *is* the registry, where the source and the registry are the same directory and the removal takes it. The answer says so when that is what happened.

**What a removal does and does not do** is in the summary every time, because the two halves are easy to confuse:

```
@dev/widget 0.2.0 taken out of reg (main) as 4f1c2ab: widget/ is gone, 2 file(s). It leaves the marketplace
index at the next refresh, so nobody installs it again. Every installation that already has it keeps it,
goes on running it, and is not told.
```

That last part is deliberate and not a gap. `behind` in `@thetis/marketplace` leaves a package the index no longer carries alone, because a registry dropping a package is not the same thing as a package being out of date. A removal is therefore not a recall, and from the product's point of view it is irreversible: git has the history, nothing else does.

## The gates

Each refuses with one sentence that names what to do, and carries a code:

| `err.code` | Refused when |
|---|---|
| `not-newer` | The version does not move past what the target already holds for that package. This is the central rule: a publish nobody's update check can see is not a publish. What the target holds is read from the registry's own branch, not from the working tree. A package the target does not hold at all is a first publish and passes. |
| `manifest` | No `name`, no `version`, no `thetis`, a `main` that is not there, or a version that is not semantic. The kernel's install checks, made before the push instead of after it. |
| `name-mismatch` | The directory in the registry already holds a different package, so the copy would replace it. Measured against the name the publish carries, which for a fork going out as its origin is the origin's; on a removal, that the directory holds the package that was named. |
| `ambiguous-fork` | The package carries `thetis.forkedFrom`, the target holds that origin, and the target does not yet hold this fork, so the publish could be two things and `as` did not say which. `err.details` is `{ origin, fork }`. Reported on a dry run rather than thrown. |
| `not-a-fork` | `as origin` on a package whose manifest has no `thetis.forkedFrom`, so there is no origin to publish it as. |
| `bad-as` | `as` is a word that is neither `origin` nor `itself`. |
| `fork-in-checkout` | `as origin` on a fork that is inside the registry checkout, where a publish commits the directory the package already sits in and copies nothing. |
| `not-held` | A removal of something the target does not hold, so there is nothing to take out of it. |
| `verify-failed` | `verify` is configured and its command exited non-zero, run in the package's directory. |
| `dirty-index` | The working tree in the checkout case has other files staged. They are named, and so is the fact that only this package's directory would go. They are neither committed nor dropped. |
| `unpushed-others` | The branch carries commits, not yet in the registry, to a package that cannot be published on its own. Absolute: naming it in `with` raises the same refusal. `err.details` is `{ blocked, nameable }`, each row `{ dir, package, version, holds, holdsName, moved, publishable, reason, problem, files }`, `reason` being `not-newer`, `manifest`, `name-mismatch` or `not-a-package`. |
| `unnamed-others` | Everything the branch is carrying could be published, and none of it was named. `err.details` is `{ nameable }`. This is the common one, so the sentence asks for a word rather than a procedure and prints the command that says it. |
| `not-a-passenger` | `with` names something that is not riding on this branch. |
| `no-targets`, `unknown-target`, `ambiguous-target` | No target is configured, `to` names one that is not, or more than one is configured and `to` was left out. |
| `no-package`, `not-found` | No package was named, or what was named is neither installed here nor a directory the fence can reach. |
| `bad-version` | `version` and `bump` both given, a version that is not semantic, or a `bump` that is not `patch`, `minor` or `major`. |
| `package-is-repo-root` | The package is the root of the registry repository, so there is no one directory to commit. |
| `git`, `push` | Git said no: the registry could not be reached, the commit failed, or the push was refused. Git's own words are in the sentence. |
| `config` | A target in the configuration is not `{ name, url, branch? }`. |

`dryRun` does everything up to the commit -- the clone, the fetch, the copy, every gate -- and reports what would happen, including `was`, `now` and the files that would go. In the checkout case it lists the files with `git add --dry-run`, so the maintainer's index is exactly as it was found.

The three gates about the state of the tree, `dirty-index`, `unpushed-others` and `unnamed-others`, are **reported** on a dry run rather than thrown: a dry run changes nothing, so there is nothing to protect by refusing, and "what would this publish, and what could I add?" is only answered properly by naming both the passengers and the ones that could come along. They come back in `blockers[]`, each with its `code`, its `message` and its `details`; `nameable` lists the publishable passengers whether or not they were named; and `ok` is then false. Every other gate refuses either way, `not-a-passenger` included, because a name that is not riding is a mistake in the call and reporting it back as a finding would be reporting the caller their own typing. `thetis publish --dry-run` prints each blocker, prints `could add <name>` for each nameable passenger, and exits non-zero.

## Configuration

`config.packages["@thetis/package-publish"]`:

| Key | Default | Meaning |
|---|---|---|
| `targets` | `[]` | Where this workspace may publish, each `{ name, url, branch? }`. A writable git url for a registry; `branch` defaults to the remote's head, or the checked-out branch in the checkout case. Empty publishes nowhere, which is the default. |
| `verify` | unset | A command run in the package's directory before anything is committed; a non-zero exit refuses the publish. Unset, only the manifest is checked. The timeout is 600000 milliseconds. |
| `workDir` | `publish` | Where clones of the targets are kept, under the person's home. |

The package reads no environment variables. It sets two for every git command it runs: `GIT_TERMINAL_PROMPT=0` and `GIT_SSH_COMMAND="ssh -o BatchMode=yes"`, so a registry that will not authenticate fails instead of waiting at a prompt nobody is watching. A fence has no `~/.gitconfig`, so a commit made where git has no identity is made as `thetis <thetis@localhost>`; the answer's `author` says which identity signed it.

## Use

Say where this workspace may publish, then publish:

```sh
thetis config set @thetis/package-publish targets --json '[{"name":"thetis","url":"git@github.com:thetis-agent/packages.git"}]'
thetis publish @thetis/exa --to thetis --dry-run
thetis publish @thetis/exa --to thetis --bump patch
thetis publish @thetis/exa --to thetis --bump patch --with @thetis/skills --with @thetis/ui-admin
thetis publish @alice/exa --to thetis --as origin --bump minor     # a fork, upstreamed
thetis publish @alice/exa --to thetis --as itself --version 1.0.0  # a fork, going its own way
thetis unpublish @alice/hello --to thetis --dry-run
thetis unpublish @alice/hello --to thetis
```

Tool calls as the model makes them:

```
publish_targets { package: "@alice/hello" }
publish_package { package: "packages/hello", to: "thetis", bump: "minor", dryRun: true }
publish_package { package: "@thetis/exa", version: "0.4.0", message: "exa 0.4.0: pinned results" }
publish_package { package: "@thetis/exa", bump: "patch", with: ["@thetis/skills"] }
publish_package { package: "@alice/exa", to: "thetis", as: "origin", bump: "minor" }
unpublish_package { package: "@alice/hello", to: "thetis" }
```

A refused publish says what to do next:

```
@thetis/exa 0.3.0 does not move past 0.3.0, which thetis already holds, so no update check anywhere
would see this publish. Raise the version to 0.3.1 or later, then publish it.
```

The one a fork meets, which names both ways out and prints the command for each, because either could be
what was meant:

```
@dev/widget-mine is a fork of @dev/widget, and thetis already holds @dev/widget in widget/, so this publish
could be two different things and only you know which. To make the change the next version of @dev/widget,
publish it as its origin: thetis publish @dev/widget-mine --to thetis --as origin --version 0.1.1. To make
it a package of its own, apart from @dev/widget from here on, publish it as itself: thetis publish
@dev/widget-mine --to thetis --as itself. Your own copy stays @dev/widget-mine either way.
```

```
Other files are staged in /tank/data/Dev/thetis-agent/runtime/packages: skills/index.js, ui-admin/fleet.js.
A publish commits only exa/, so those would be left behind. Unstage them with git restore --staged <path>,
or commit them yourself, and publish again.
```

And the two a maintainer meets most, because committing across several packages and shipping one is the habit. When everything riding could be published, it asks for a word:

```
Commits on this branch touch more than exa/ and are not in thetis yet, and a publish pushes the branch,
so they would go with it: @thetis/skills 0.3.0 here, 0.2.0 in thetis. Each of those can be published in
its own right, but a version having moved is not the same as meaning to ship it, so nothing goes that you
did not ask for. Publish them deliberately alongside this one (thetis publish exa --with @thetis/skills),
or move them off this branch first: git branch keep; git reset --hard origin/main; git checkout keep -- exa.
```

When something riding cannot be published, no word helps and it gives the procedure instead:

```
Commits on this branch touch more than exa/ and are not in thetis yet, and a publish pushes the branch,
so they would go with it. These cannot be published, and saying you want them anyway will not change
that: @thetis/ui-admin is 0.4.0 here and in thetis, so its code would land under a version every
installation already believes it has. Put them aside and bring things back one at a time: git branch
keep; git reset --hard origin/main; git checkout keep -- exa; then publish exa/, and each of the others
in its turn. Once they are off the branch, @thetis/skills 0.3.0 here, 0.2.0 in thetis could go along
with it.
```

## The journal, and what is written instead

A publish is exactly the kind of act the kernel's journal is for, and there is no seam for it. A tool runs inside a fence with a `ToolEnv`, which carries no journal; the only interface that does is `HostEnv`, which a host package on the service plane receives and a fence never does, and the operator channel has `journal.tail` and nothing that appends. So the rows are not written and not faked: `publish_package` returns them, in `answer.journals`, each `{ kind: "package.publish", target: <package>, data: { name, was, version, target, url, branch, commit, first } }`, for a caller that does have the seam. `was` is absent on a first publish. It is a **list**, primary first, because one act publishes one package plus whatever it was told to take with it, and a field that could only ever hold one of them would be a lie the moment `with` is used.

A removal answers a row of its own kind, `package.unpublish`, rather than a publish with a field saying otherwise: a history that has to be read with a flag in mind is a history that gets misread, and "this package left the registry" is a different event from "this package has a new version". An as-origin publish adds one field to its row, `fork`, naming the copy the code came out of, because the row itself says `@dev/widget` and nothing else would say whose work it was.

What is written is the package's own record, through `env.storage("publishes")`: one document per package published, one `last_<target>` per target and one `lastRemoval_<target>`, keyed by the kernel under this person and this package. A rider's document carries `alongside`, the package it went with, because a year later that is the difference between "I shipped this" and "I let this go with something else". `publish_targets` reads the last one back for each target, so the record is visible rather than write-only. A caller with no store, such as the command line, loses the record and nothing else.

## After the push

`answer.source` is `<url>#<dir>@<commit>`, the pin `@thetis/marketplace` will carry for this package, and `answer.indexed` is `false`. The registry holds the new version the moment the push returns; the index a gallery reads does not, and will not until the marketplace service's next refresh, which is its own schedule (30 minutes by default) and nothing here can hurry. A caller that does not say so shows a badge with the old version on it and looks as though nothing happened.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: two tools and three configuration keys. |
| `index.js` | The two tool exports, and the library re-exported for a caller in the same fence. |
| `lib/publish.js` | The act: the gates in order, the version write, the copy, the commit, the push, the answer. |
| `lib/unpublish.js` | The opposite act: the directory taken out, the same gates that still mean something, and what a removal does not do. |
| `lib/passengers.js` | What else is riding on the branch, and the sentences about it. Shared, because a removal pushes a branch too. |
| `lib/fork.js` | Which publish a fork's is, the refusal that asks, and the version an as-origin publish goes out at. |
| `lib/targets.js` | `publish_targets`: the configured list, and what each target holds. |
| `lib/locate.js` | Resolving a package by name or path, and the checkout case against the copy case. |
| `lib/git.js` | Every git command, quoted, with the environment that stops it waiting at a prompt. |
| `lib/git-url.js` | `repoKey` and `sameRepository`: two git urls compared as repositories. |
| `lib/semver.js` | The version rules. |
| `lib/manifest.js` | The manifest gate, and the version write that leaves the rest of the file alone. |
| `lib/config.js` | `targets`, `verify` and `workDir`, read into the shapes the rest uses. |
| `lib/record.js` | The package's own record, and what the kernel's journal has no seam for. |
| `lib/refuse.js` | `Refusal`, and the two helpers that keep a sentence readable in a toast. |

## Tests

`npm test` from the runtime root, or `node --test "packages/package-publish/test/*.test.js"`. Plain `node --test` over temporary directories and local bare repositories reached with `file://`, which is a real remote as far as git is concerned: the clone, the commit and the push all take the same paths they would against github, and nothing in the tests can reach a network.

`test/publish.test.js` covers both sources end to end, the first publish, a version that does not move, a file that leaves the package, `node_modules` never travelling, a checkout that is behind the registry, both dry runs, and the journal row. `test/gates.test.js` covers every refusal and the sentence it makes, including a sibling package in each of the three states it can be in (unstaged, staged, committed) against one registry and one publish; a publishable sibling waiting to be named and then riding as a publish of its own, with its own journal row and record; a sibling that cannot be published being refused even when it is named; a name that is not riding; a rider whose `verify` fails; and the copy case proving that a local commit planted in the clone is reset away rather than pushed. `test/targets.test.js` covers `publish_targets` with and without a package, an unsound package reported instead of thrown, one unreachable registry among two, the record read back, and the coercion the tool wrappers do. `test/git-url.test.js` and `test/semver.test.js` are the two rules on their own.

`test/lifecycle.test.js` is worth more than the rest of them put together, because it is the only one that could have caught either of the holes the others were written around. It walks the whole loop in the order a person walks it -- create a package, publish it, fork it, change the fork, publish the change as the origin, go back to the origin, remove the package -- and asserts what the registry holds after every step. Every single step passed on its own while the loop did not close. `test/fork.test.js` is the corners of the fork gate: when the question is asked and when it is not, what `as` refuses, and where an as-origin version comes from. `test/unpublish.test.js` is the removal: by name with nothing local, by the directory a registry keeps it in, both sources, every refusal, and the branch gates a removal meets because it pushes too.
