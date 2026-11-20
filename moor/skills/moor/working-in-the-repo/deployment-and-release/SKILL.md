---
name: deployment-and-release
description: "What deploy/ and the Dockerfiles contain, how a release is gated, how keys and tokens are handled, and what an operator needs to bring a real world up. Use when you touch a compose file, a Kubernetes manifest, a Dockerfile, a deployment script or a Debian package, because CI renders all of these on every push. Use it also when planning a real deployment: which shape to pick, how keys are made, and what must never reach a diff. Not for the development loop, and not for the Torchship database."
metadata:
  title: Deploying and releasing mooR
  tags: [moor, deploy, deployment, release, docker, docker-compose, kubernetes, debian-package, systemd, nginx, tls, enrollment-token, signing-key, backup, ghcr, v2-0-release, version-skew, upgrade]
  related: [moor/services/daemon-and-rpc, moor/content-pipeline/cores-and-bootstrap]
  version: 2
---

# Deploying and releasing mooR

Deployment lives in `deploy/`, in the Dockerfiles at the repository root, and in
per-crate Debian packaging metadata. It has two audiences and they want
different things from this material.

**The contributor's concern.** CI validates deployment on every push, without
deploying anything. It syntax-checks every shell script under `deploy/` and the
Meadow deployment directory, renders every listed compose file, renders the
Kubernetes manifests through kustomize, builds the frontend image and checks it
has a payload, and builds and inspects the Meadow Debian package. A change to a
YAML file, a script or a packaging manifest can therefore fail the build without
touching a line of Rust. If you edit any of those, render them locally first.

**Which version.** New users take the `v2.0-release` branch, version
`2.0.0-dev` in code freeze; `main` is `2.1.0-dev`. 2.0 has no release packages or
container images yet, so the README tells users to clone the branch and run
`scripts/start-moor-cowbell.sh` or `scripts/start-moor-lambdacore.sh`, which build
locally. The `deploy/` examples still name `ghcr.io/timbran-project/moor:latest`,
which is a 1.0 image until a 2.0 release is published. The 1.0 line is no longer
supported.

**The operator's concern.** Everything else on this page: which shape to pick,
how keys and tokens are made, what to back up, and how to upgrade. A contributor
does not need to know it to land a patch, but does need to know it before
changing a default that an installed system depends on.

## The shapes

| Shape | Location | For |
|---|---|---|
| Development stacks | Root `docker-compose.yml` (through `scripts/start-moor-*.sh`), `scripts/dev.sh`, `bacon.toml`, the npm scripts | Local work, and the 2.0 route for new users. See `moor/working-in-the-repo/build-and-run` |
| Single-process, basic | `deploy/single-process/basic/` | One container running the `moor` binary: telnet, the embedded web API, and the embedded curl worker |
| Single-process, web | `deploy/single-process/web/` | The same, plus an nginx container serving the Meadow browser client |
| Clustered, telnet only | `deploy/clustered/telnet-only/` | Separate daemon and telnet host over IPC |
| Clustered, web | `deploy/clustered/web-basic/`, `deploy/clustered/web-ssl/` | Separate daemon, web host, workers and nginx frontend; web-basic also runs the git worker. The SSL variant adds Let's Encrypt through certbot |
| Clustered, over TCP | `deploy/clustered/docker-compose.tcp.yml` | Demonstrates multi-machine communication: TCP sockets, CURVE encryption and enrollment tokens |
| Kubernetes | `deploy/clustered/kubernetes/` | A stateful daemon, deployments for hosts and workers, services, ingress, network policy, autoscaling |
| Debian packages | `deploy/debian-packages/`, and `[package.metadata.deb]` in the crate manifests | A systemd installation on Debian or Ubuntu |

The single-process shape is the intended default for a one-host install. The
clustered shapes exist because the daemon and its hosts are genuinely separable:
a host can restart, or live on another machine, while the world stays up.
`moor/services/daemon-and-rpc` explains that boundary.

Each deployment directory carries its own `README.md` and, where relevant, a
`start.sh` and a `test.sh`. `deploy/test-all.sh` runs the deployment tests
together. Those scripts are the operator's entry point, and they are also what
CI syntax-checks.

## The Dockerfiles

| File | Builds |
|---|---|
| `Dockerfile` | The backend. A Node stage builds the frontend, a `rust:1.98.1-bookworm` stage builds the workspace, a slim Debian stage takes the binaries: `moor`, daemon, hosts, and the curl, file and git workers. The `backend` target is the server binaries alone; the `default` target adds the built browser client |
| `clients/meadow/Dockerfile` | The frontend image: a Node build stage, then `nginx:1.31.9-alpine` serving the static bundle. Its `frontend` target is what the release publishes |
| `Dockerfile.elle` | The consistency-check environment: the workload binaries plus a JVM and the external Elle checker |
| `Dockerfile.arm64-cross` | Cross-building for arm64 from an x86-64 host |
| `deploy/Dockerfile-forgejo-builder` | A CI image with the toolchain, Node, a JVM, Leiningen, licensure and graphviz preinstalled |

The root Dockerfile takes build arguments for the cargo profile, the job count
and extra cargo flags. Its default profile is a debug build; the
root compose file overrides that to the fast release profile, and the release
workflow overrides it to the full release profile. Know which one you are
getting before you judge a container's performance.

The build stages copy `.git` into the image because the build stamps a version
and commit hash into every binary. That stamp is what a bug report quotes.

Every Rust stage uses Rust 1.98.1, the workspace `rust-version`. Every nginx
image, in the Dockerfiles and the deploy compose files, is pinned to
`nginx:1.31.9-alpine`, which fixes two unauthenticated HTTP/2 remote code
execution bugs. Do not go back to a floating `nginx:alpine` tag: a cached,
vulnerable base would be reused.

### docker-compose against scripts/dev.sh

They answer different questions. `docker-compose` builds images and runs
containers, so it tests packaging, networking and the runtime image as well as
the code. `scripts/dev.sh` runs the split processes directly on the host from
cargo, so it is much faster to iterate and tests only the process topology. Use
`scripts/dev.sh` while developing across the process boundary, and
docker-compose when the packaging itself is in question.

## The release

A release is a git tag. The publish workflow gates it hard before it builds
anything:

1. The tag must be semantic version shaped, with an optional pre-release suffix.
2. The checked-out commit must be the tag's commit.
3. The `version` field in the root `package.json` must equal the tag exactly.
4. The tag must be reachable from `v${major}.0-release`, the release branch for
   its major version. A 2.0 tag must be on `v2.0-release`.

Then it builds two images, the backend and the frontend, for both amd64 and
arm64, pushes each architecture under its own suffixed tag, attests build
provenance, and finally creates multi-platform manifest tags. A stable tag also
gets the major-and-minor alias and `latest`; a pre-release tag gets neither.
After publishing it verifies that each manifest really carries both
architectures.

The consequence for a contributor: **the version in `package.json` is part of
the release contract.** It is the only place the tag is checked against, so a
version bump is a deliberate act, not housekeeping.

`deploy/release/build-packages.sh` is the separate path for Debian artefacts on
the native architecture, plus the architecture-independent web files.

### Debian packaging

Packaging metadata lives in each binary crate's `Cargo.toml`, with the unit
files, default configuration and maintainer scripts beside it in that crate's
`debian/` directory. `cargo-deb` builds them.

The single-process `moor` package conflicts with and replaces `moor-daemon`,
because the two own different service models. Install one or the other, never
both. Split installations also take telnet host, web host and web client
packages.

The maintainer script creates a system user and the configuration, data and
spool directories, and tightens permissions on the configuration directory. The
systemd unit sets the XDG configuration and data directories so that the server
finds its key and its state in system locations, generates a key pair if none
exists, and restarts on failure. The package ships a LambdaCore-derived core and
points the default configuration at it; changing the core is a configuration
edit and a restart.

## Keys, tokens and secrets

Three different secrets exist. Do not confuse them.

| Secret | What it authenticates | How it is made |
|---|---|---|
| The signing key pair | Client and host session tokens. An ed25519 pair, used for PASETO tokens | `--generate-keypair` creates it on first start if absent. The default location is under the XDG configuration directory, and the paths can be given explicitly |
| CURVE keys | The ZeroMQ transport, on TCP deployments only | Generated for the transport. IPC and single-process deployments do not need them |
| The enrollment token | A host or worker joining a daemon | Generated once and shared with every component. The TCP compose file generates it into a shared volume on first run; the Kubernetes manifests generate it into a cluster Secret |

Same-machine deployments use IPC sockets and need no CURVE enrolment at all.
That is why the local stacks start with nothing but `--generate-keypair`.

**Artefacts that must stay out of a diff.** The repository ignores private key
files by pattern, export directories, certificate directories, run directories,
the production deployment directory, and configuration files holding OAuth2
secrets. `CONTRIBUTING.md` names the signing key file explicitly. If a key,
an export or a database directory appears in `git status`, something wrote into
the working tree that should have written into a data directory. Do not commit
it, and do not add it to the ignore list to hide it: work out which command put
it there.

## Bringing a real world up

Facts that separate a real deployment from a development one.

**Choose the core deliberately, once.** The import runs only when the database
does not yet exist. Whichever core you point at on first start is the world you
have. The development launchers and the clustered examples do not agree on which
core they import. See `moor/content-pipeline/cores-and-bootstrap`.

**Change the wizard password after the first login.** A freshly imported core
has whatever the core shipped.

**Ports.** Telnet and the web interface are the two a player reaches. The web
host's own listener and the frontend are separate; in the deployment examples
nginx serves the client and proxies the API. Clustered deployments expose their
ZeroMQ endpoints only when configured to, and a single-process deployment
exposes none. The current defaults are in each example's compose file and
`.env.example`; read those rather than a list here.

**TLS.** The telnet host terminates TLS itself, given a port, a certificate and
a key. The web host does not: HTTPS in the examples is terminated by nginx, by
certbot in the SSL variant, or by a Kubernetes ingress. Do not expect a
`--tls` option on the web host.

**Backups.** The database directory is the state. Stop the service, archive the
directory, start it again. An export snapshot is a second form of backup, and
`deploy/scripts/restore-from-export.sh` restores from one. Checkpoint interval is
a daemon option and controls how often state is written out.

**Upgrades.** Back up first, then replace the image or the packages, then
restart. There are no migration shims in this project by design, so a database
written by a newer server is not expected to be readable by an older one. A
database whose format marker differs from `CURRENT_DB_VERSION` is refused at open
(`crates/db/src/provider/fjall_format.rs`). So 2.0 does not open a 1.0 database in
place: export it with 1.0, then import the export into a new database.

**Run one version everywhere.** The 2.0 RPC schema changed without compatibility
(f50464d59: task replies became one `TaskOutcome` shape). Hosts, workers and the
daemon must run the same version. In a clustered or Kubernetes shape, upgrade every
component together; a host from another version enrols but its requests and
replies do not decode.

## Failure branches

| Symptom | Cause | Action |
|---|---|---|
| CI fails and you changed no Rust | You edited a compose file, a manifest, a deployment script or packaging metadata | Render the compose files, run kustomize over the Kubernetes directory, and syntax-check the scripts, exactly as the deployment job does |
| The release workflow refuses the tag | The tag is not semantic, the commit does not match, the `package.json` version differs, or the tag is not on the release branch | All four are checked before anything builds. The failing step names which |
| An image tag is published but `latest` does not move | The tag was a pre-release | Only stable tags get the major-and-minor alias and `latest` |
| A container build fails on the toolchain | A Dockerfile's base image is older than the workspace `rust-version` | All Rust stages use 1.98.1 now. A local edit or a stale cache is the likely cause |
| Hosts and the daemon fail on every request after an upgrade | The components run different versions | Upgrade all of them to one version. See "Run one version everywhere" |
| `docker compose pull` gets a 1.0 server for a 2.0 world | The deploy examples use the `latest` tag, and no 2.0 image is published yet | Build from `v2.0-release` locally until the 2.0 release |
| A container build takes hours | The profile argument was not set, or was set to the full release profile | The fast release profile exists for packaging. See `moor/working-in-the-repo/build-and-run` |
| A build produces an unstamped binary | `.git` was not available in the build stage | The Dockerfiles copy it deliberately. Do not remove that |
| A host or worker will not join the daemon | Enrollment token mismatch, or CURVE not configured for a TCP deployment | Confirm every component reads the same token. On one machine, prefer IPC and skip the whole mechanism |
| Sessions break after a restart | The signing key pair changed | The key must persist across restarts. Check that the configuration directory is a volume and not container-local storage |
| Installing both `moor` and `moor-daemon` fails | They conflict on purpose | Pick the single-process package or the split packages |
| The world is empty or is the wrong core after deployment | The data directory already existed, so the import was skipped, or a different core was imported | Inspect the data directory before assuming a bug. A fresh import needs a fresh directory |
| A key or an export appears in `git status` | A command wrote into the working tree | Find the command and give it a data directory. Never commit it |

## Read first / read next

Read `moor/working-in-the-repo/build-and-run` first for
the development stacks and the cargo profiles, and
`moor/working-in-the-repo/repo-tooling` for the scripts.
Read `moor/services/daemon-and-rpc` before changing
anything about enrolment, sockets or the process boundary, and
`moor/content-pipeline/cores-and-bootstrap` before
changing import or first-start behaviour. Read
`moor/working-in-the-repo/conventions` for what must stay
out of a diff.
