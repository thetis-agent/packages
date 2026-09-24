/* The Registries page, for admins: which git registries this installation's marketplace mirrors, and how
 * it reaches each one. Opened from the gallery's toolbar as the place with `{ view: "registries" }`; the
 * crumb goes back. The button and the page exist only where `ext.can("registries")`, which is the gateway
 * saying the person's role clears the admin verbs; the verbs themselves are refused by the gateway and the
 * kernel for anybody else, so hiding them is manners and not the lock.
 *
 * Authentication is derived and never recorded: a registry uses SSH exactly when a repository key is held
 * for its url, so the card shows the key itself -- fingerprint, whether the file is on the host, the public
 * half to copy -- rather than a setting that claims one. A key is made by the host (Generate) or pasted once
 * (Paste a private key) and is the installation's, held by the system fence's agent and offered for that
 * repository only; its public half goes on the git host as a read-only deploy key, and Test asks the host
 * to read the repository with it. Everything the page needs worked out from a url -- whether it can take a
 * key, where its deploy keys page is -- comes from the server, which owns git-url; the page parses nothing.
 * Every write sends one verb, answers the whole section again, and is drawn from that answer. */

/** What the last refresh says, in one line and a tone. */
export function refreshLine(r) {
  if (r.error) return { tone: "err", text: "The last refresh failed." };
  if (r.commit) return { tone: "ok", text: `Mirrored at ${String(r.commit).slice(0, 7)}.` };
  return { tone: "dim", text: "Not refreshed yet." };
}

/** The derived authentication, as the badge says it. */
export function authBadgeOf(r) {
  if (r.auth !== "ssh") return { text: "no authentication", tone: "dim" };
  return r.key?.present === false ? { text: "SSH · key missing", tone: "err" } : { text: "SSH key", tone: "ok" };
}

export function openRegistries(ext, root) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, field, heading, put, when } = ext.ui;
  let alive = true;
  let state = { registries: [], orphans: [], source: "default", updatedAt: null, keysError: null };
  let adding = false; // the add form is open
  let fresh = null; // the name of a registry just added or keyed, drawn first and outlined
  let keying = null; // the registry whose "add a key" box is open
  let editing = null; // the registry whose name/url box is open
  const tests = new Map(); // name -> { ok, head, error } | "running"
  // The open forms, kept across redraws so a Test finishing elsewhere never wipes what is being typed.
  const boxes = new Map();
  const kept = (id, make) => (boxes.has(id) ? boxes.get(id) : boxes.set(id, make()).get(id));
  const drop = (id) => boxes.delete(id);

  const crumbBack = button("Marketplace", { tone: "quiet" });
  crumbBack.addEventListener("click", () => ext.open.place("marketplace", {}));
  const crumb = el("nav", { class: "mk-crumb", "aria-label": "Where you are" }, crumbBack, el("span", { class: "mk-crumb-sep", "aria-hidden": "true" }, "›"), el("span", { class: "mk-crumb-name" }, "Registries"));
  const wrap = el("div", { class: "mk-reg" });
  root.append(el("div", { class: "place-page mk-place" }, crumb, wrap));

  async function load() {
    const stop = busy(wrap, "Reading the registries…");
    try {
      const out = await ext.request("registries");
      if (!alive) return;
      take(out?.data);
    } catch (err) {
      if (alive) ext.toast(err?.message || "The registries could not be read.", { tone: "error" });
    } finally {
      stop();
    }
    if (alive) draw();
  }

  /** Every write answers the section whole; this keeps it. */
  function take(data) {
    if (!data || !Array.isArray(data.registries)) return;
    state = { registries: data.registries, orphans: Array.isArray(data.orphans) ? data.orphans : [], source: data.source ?? "default", updatedAt: data.updatedAt ?? null, keysError: data.keysError ?? null };
  }

  /** One write: the verb, the toast, and the redraw from its answer. A refusal is its own sentence. */
  async function send(verb, args, done, after) {
    try {
      const out = await ext.request(verb, { args });
      take(out?.data);
      after?.(out?.data);
      ext.toast(done, { tone: "good" });
    } catch (err) {
      ext.toast(err?.message || `${verb} failed.`, { tone: "error" });
      return false;
    }
    if (alive) draw();
    return true;
  }

  /** The "keep the key file" tick, drawn inside a confirm popover and read after it closes. */
  function keepTick() {
    const box = el("input", { type: "checkbox", class: "mk-reg-tick" });
    return { box, node: el("label", { class: "mk-reg-keep" }, box, "keep the key file on the host") };
  }

  // ---- the parts of a card ----------------------------------------------------------------

  function copyLine(text, label) {
    const box = el("input", { class: "input mk-reg-pubkey", type: "text", readonly: "", "aria-label": label, spellcheck: "false" });
    box.value = text;
    box.addEventListener("focus", () => box.select());
    const copy = button("Copy", { onClick: () => navigator.clipboard?.writeText(box.value).then(() => ext.toast("Copied.", { tone: "good" }), () => { box.focus(); ext.toast("Select the line and copy it.", { tone: "error" }); }) });
    return el("div", { class: "row mk-reg-pubkey-row" }, box, copy);
  }

  /** Where the public half goes: GitHub's deploy keys page for the repository, or the words for any other host. */
  function deployHint(deployUrl) {
    const where = deployUrl ? el("a", { href: deployUrl, target: "_blank", rel: "noopener noreferrer" }, "the repository's deploy keys") : "the git host, on the repository's deploy keys";
    return el("p", { class: "text-faint" }, "Add this as a read-only deploy key: ", where, ". The private half stays on the host; only the system workspace's agent can use it, and only for this repository.");
  }

  function row(label, ...value) {
    return el("div", { class: "mk-reg-row" }, el("span", { class: "mk-reg-label" }, label), el("div", { class: "mk-reg-value" }, ...value));
  }

  /** The Test button and what the host said last time. */
  function testLine(r) {
    const result = tests.get(r.name);
    const go = button(result === "running" ? "Testing…" : "Test", { disabled: result === "running" || null, title: "git ls-remote on the host, with this key and no other", onClick: () => void test(r) });
    let said = null;
    if (result && result !== "running") {
      said = result.ok
        ? el("div", { class: "mk-reg-test" }, badge("read", "ok"), el("span", {}, "The repository answered. HEAD is ", el("code", {}, String(result.head || "").slice(0, 12) || "unknown"), "."))
        : el("div", { class: "mk-reg-test" }, badge("refused", "err"), result.error ? el("pre", { class: "mk-reg-pre" }, result.error) : el("span", {}, "git said nothing."));
    }
    return el("div", { class: "mk-reg-value-stack" }, el("div", { class: "row" }, go), said);
  }

  async function test(r) {
    tests.set(r.name, "running");
    draw();
    try {
      const out = await ext.request("registry-test", { args: { name: r.name } });
      tests.set(r.name, out?.data ?? { ok: false, error: "no answer" });
    } catch (err) {
      tests.set(r.name, { ok: false, error: err?.message || String(err) });
    }
    if (alive) draw();
  }

  /**
   * How a key is made: Generate, or Paste a private key into a box. Used by the add form and by a
   * registry's own "Add a key", so a key is made the same way everywhere. `value()` answers what to send.
   */
  function keyChooser(group) {
    let mode = "generate";
    const material = el("textarea", { class: "input mk-reg-material", rows: "6", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----", "aria-label": "Private key", spellcheck: "false", autocomplete: "off", hidden: true });
    const pick = (value, label, note) => {
      const input = el("input", { type: "radio", name: group, value, checked: value === mode || null, onChange: () => { mode = value; material.hidden = mode !== "import"; } });
      return el("label", { class: "mk-reg-choice" }, input, el("span", {}, el("strong", {}, label), el("span", { class: "text-faint" }, ` — ${note}`)));
    };
    const node = el(
      "div",
      { class: "mk-reg-chooser" },
      pick("generate", "Generate a key", "the host makes an ed25519 key for this repository and shows its public half"),
      pick("import", "Paste a private key", "a deploy key that already exists; sent once, never shown again, and refused if it has a passphrase"),
      material
    );
    return {
      node,
      value() {
        if (mode === "generate") return { auth: "generate" };
        const text = material.value;
        if (!text.trim() || !text.includes("PRIVATE KEY")) {
          material.focus();
          ext.toast("Paste the whole private key, BEGIN and END lines included.", { tone: "error" });
          return null;
        }
        return { auth: "import", privateKey: text };
      },
    };
  }

  /** A registry without a key: the box that gives it one. */
  function keyBox(r) {
    const chooser = keyChooser(`mk-reg-key-${r.name}`);
    const go = button("Make the key", { tone: "primary", onClick: () => void make() });
    async function make() {
      const chosen = chooser.value();
      if (!chosen) return;
      const ok = await confirm(go, { title: `A key for ${r.name}?`, lines: [["registry", r.name], ["url", r.url], ["key", chosen.auth === "generate" ? "generated on the host" : "the pasted private key"]], note: "The system workspace reloads with the key in its agent; the marketplace reaches this repository with it from the next refresh. Register the public half as a read-only deploy key.", confirmLabel: "Make it" });
      if (!ok) return;
      go.disabled = true;
      const done = await send("registry-key", { name: r.name, ...chosen }, `${r.name} has a key. Add its public half as a deploy key.`, () => { drop(`key:${r.name}`); keying = null; fresh = r.name; tests.delete(r.name); });
      if (!done) go.disabled = false;
    }
    return el("div", { class: "mk-reg-box" }, chooser.node, el("div", { class: "row" }, go, button("Cancel", { onClick: () => { drop(`key:${r.name}`); keying = null; draw(); } })));
  }

  /** The name and url of a registry, edited in place. */
  function editBox(r) {
    const name = el("input", { class: "input", type: "text", value: r.name, "aria-label": "Name", autocomplete: "off", spellcheck: "false", maxlength: "64" });
    const url = el("input", { class: "input mk-reg-url", type: "text", value: r.url, "aria-label": "URL", autocomplete: "off", spellcheck: "false" });
    const go = button("Save", { tone: "primary", onClick: () => void save() });
    async function save() {
      const next = { name: r.name, newName: name.value.trim(), url: url.value.trim() };
      if (next.newName === r.name && next.url === r.url) return void (drop(`edit:${r.name}`), (editing = null), draw());
      const ok = await confirm(go, { title: `Change ${r.name}?`, lines: [["name", next.newName || r.name], ["url", next.url || r.url]], note: "The marketplace restarts and refreshes from the new list. A renamed registry's packages are listed under the new name after that refresh.", confirmLabel: "Save" });
      if (!ok) return;
      await send("registry-edit", next, `${next.newName || r.name} was saved.`, () => { boxes.clear(); editing = null; });
    }
    return el("div", { class: "mk-reg-box" }, el("div", { class: "mk-reg-grid" }, field("Name", name), field("URL", url, r.auth === "ssh" ? "The key is this repository's: revoke it before pointing the registry at another one." : null)), el("div", { class: "row" }, go, button("Cancel", { onClick: () => { drop(`edit:${r.name}`); editing = null; draw(); } })));
  }

  async function removeRegistry(anchor, r) {
    const keep = keepTick();
    const lines = [["registry", r.name], ["url", el("code", { class: "mk-wrap" }, r.url)]];
    if (r.key) lines.push(["key", el("code", {}, r.key.fingerprint || "fingerprint unknown")], ["", keep.node]);
    const note = `Its packages leave the index at the next refresh; what is already installed stays installed.${r.key ? " Its repository key is revoked from the system workspace's agent, and the key file deleted unless kept." : ""}`;
    const ok = await confirm(anchor, { title: `Remove ${r.name}?`, lines, note, confirmLabel: "Remove", tone: "warn" });
    if (!ok) return;
    const keepKey = !!keep.box.checked;
    await send("registry-remove", { name: r.name, keepKey }, `${r.name} was removed${r.key ? (keepKey ? "; its key file was kept." : " with its key.") : "."}`, () => tests.delete(r.name));
  }

  async function revokeKey(anchor, args, label, fingerprint) {
    const keep = keepTick();
    const ok = await confirm(anchor, { title: `Revoke the key for ${label}?`, lines: [["key", el("code", {}, fingerprint || "fingerprint unknown")], ["", keep.node]], note: "The system workspace reloads without it; a private registry refuses the next refresh until a key is added again. Remove the deploy key on the git host too.", confirmLabel: "Revoke", tone: "warn" });
    if (!ok) return;
    const keepKey = !!keep.box.checked;
    await send("registry-key-revoke", { ...args, keepKey }, `The key for ${label} was revoked${keepKey ? "; the file was kept." : "."}`, () => args.name && tests.delete(args.name));
  }

  function registryCard(r) {
    const a = authBadgeOf(r);
    const refresh = refreshLine(r);
    const editBtn = button(editing === r.name ? "Close" : "Edit", { onClick: () => { drop(`edit:${r.name}`); editing = editing === r.name ? null : r.name; draw(); } });
    const removeBtn = button("Remove", { tone: "warn", onClick: () => void removeRegistry(removeBtn, r) });
    let auth;
    if (r.key) {
      const revokeBtn = button("Revoke key", { tone: "warn", onClick: () => void revokeKey(revokeBtn, { name: r.name }, r.name, r.key.fingerprint) });
      auth = [
        row("Key", el("div", { class: "row mk-reg-keyline" }, r.key.fingerprint ? el("code", { class: "mk-reg-fp" }, r.key.fingerprint) : el("span", { class: "text-faint" }, "fingerprint unknown"), r.key.present ? null : badge("not on the host", "err"), el("span", { class: "toolbar-gap" }), revokeBtn)),
        row("Public key", r.key.publicKey ? copyLine(r.key.publicKey, "Public key") : el("span", { class: "text-faint" }, "The public half is not on the host beside this key."), deployHint(r.deployKeysUrl)),
        row("Test", testLine(r)),
      ];
    } else if (r.keyable) {
      const addKey = button(keying === r.name ? "Close" : "Add a key", { onClick: () => { drop(`key:${r.name}`); keying = keying === r.name ? null : r.name; draw(); } });
      auth = [row("Key", el("div", { class: "row mk-reg-keyline" }, el("span", { class: "text-faint" }, "None: the repository is read without credentials, which works for a public one."), el("span", { class: "toolbar-gap" }), addKey), keying === r.name ? kept(`key:${r.name}`, () => keyBox(r)) : null)];
    } else {
      auth = [row("Key", el("span", { class: "text-faint" }, "A local path is read directly and takes no key."))];
    }
    return el(
      "div",
      { class: `card mk-reg-card${fresh === r.name ? " is-fresh" : ""}`, "data-registry": r.name },
      el("div", { class: "card-head mk-reg-head" }, el("code", { class: "mk-reg-name" }, r.name), badge(a.text, a.tone), r.error ? badge("refresh failed", "err") : null, fresh === r.name ? badge("new", "accent") : null, el("span", { class: "toolbar-gap" }), editBtn, removeBtn),
      el(
        "div",
        { class: "card-body mk-reg-body" },
        row("URL", el("code", { class: "mk-wrap" }, r.url)),
        editing === r.name ? kept(`edit:${r.name}`, () => editBox(r)) : null,
        ...auth,
        row("Refresh", el("span", { class: `mk-reg-refresh is-${refresh.tone}` }, refresh.text), r.error ? el("pre", { class: "mk-reg-pre" }, r.error) : null)
      )
    );
  }

  function orphanCard(k) {
    const revokeBtn = button("Revoke", { tone: "warn", onClick: () => void revokeKey(revokeBtn, { repo: k.repo }, k.repo, k.fingerprint) });
    return el(
      "div",
      { class: "card mk-reg-card" },
      el("div", { class: "card-head mk-reg-head" }, el("code", { class: "mk-reg-name mk-wrap" }, k.repo), badge("no registry names it", "warn"), k.present ? null : badge("not on the host", "err"), el("span", { class: "toolbar-gap" }), revokeBtn),
      el("div", { class: "card-body mk-reg-body" }, row("Key", k.fingerprint ? el("code", { class: "mk-reg-fp" }, k.fingerprint) : el("span", { class: "text-faint" }, "fingerprint unknown")), k.publicKey ? row("Public key", copyLine(k.publicKey, "Public key")) : null)
    );
  }

  /** Add a registry: its url, an optional name, and how it is reached. */
  function addCard() {
    const url = el("input", { class: "input mk-reg-url", type: "text", placeholder: "git@github.com:owner/repo.git", "aria-label": "URL", autocomplete: "off", spellcheck: "false" });
    const name = el("input", { class: "input", type: "text", placeholder: "from the url", "aria-label": "Name", autocomplete: "off", spellcheck: "false", maxlength: "64" });
    const chooser = keyChooser("mk-reg-add-key");
    let ssh = false;
    chooser.node.hidden = true;
    const mode = (value, label) => el("label", { class: "mk-reg-choice" }, el("input", { type: "radio", name: "mk-reg-auth", value, checked: (value === "ssh") === ssh || null, onChange: () => { ssh = value === "ssh"; chooser.node.hidden = !ssh; } }), el("strong", {}, label));
    const go = button("Add registry", { tone: "primary", onClick: () => void add() });
    async function add() {
      const target = url.value.trim();
      if (!target) return url.focus();
      const auth = ssh ? chooser.value() : { auth: "none" };
      if (!auth) return;
      const shown = name.value.trim() || "named from the url";
      const ok = await confirm(go, { title: "Add this registry?", lines: [["name", shown], ["url", el("code", { class: "mk-wrap" }, target)], ["authentication", auth.auth === "none" ? "none" : auth.auth === "generate" ? "SSH, a key generated on the host" : "SSH, the pasted private key"]], note: `The marketplace restarts and mirrors it from the next refresh.${ssh ? " Nothing is readable until the key's public half is added to the repository as a deploy key; the card shows it next." : ""}`, confirmLabel: "Add" });
      if (!ok) return;
      go.disabled = true;
      const done = await send("registry-add", { url: target, ...(name.value.trim() ? { name: name.value.trim() } : {}), ...auth }, "The registry was added.", (data) => { drop("add"); adding = false; fresh = data?.name ?? null; });
      if (!done) go.disabled = false;
    }
    return el(
      "div",
      { class: "card mk-reg-form" },
      el("div", { class: "card-head" }, "Add a registry"),
      el(
        "div",
        { class: "card-body" },
        el("div", { class: "mk-reg-grid" }, field("URL", url, "A git url: https, ssh, the scp-like git@host:owner/repo.git, or a local path."), field("Name", name, "Optional; the last part of the url.")),
        field("Authentication", el("div", { class: "mk-reg-modes" }, el("div", { class: "row" }, mode("none", "None"), mode("ssh", "SSH key")), chooser.node), "None reads a public repository. An SSH key is this installation's, for this repository only."),
        el("div", { class: "row" }, go, button("Cancel", { onClick: () => { drop("add"); adding = false; draw(); } }))
      )
    );
  }

  function draw() {
    clear(wrap);
    const list = [...state.registries].sort((a, b) => (fresh === a.name ? -1 : fresh === b.name ? 1 : 0));
    const addBtn = button("Add registry", { tone: adding ? "quiet" : "primary", onClick: () => { drop("add"); adding = !adding; draw(); } });
    const n = state.registries.length;
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("Registries", `${n} ${n === 1 ? "registry" : "registries"}${state.updatedAt ? ` · refreshed ${when(state.updatedAt)}` : " · not refreshed yet"}${state.source === "default" ? " · the shipped default" : ""}`), el("div", { class: "toolbar-gap" }), addBtn),
      state.keysError ? el("p", { class: "mk-error" }, `The repository keys could not be read: ${state.keysError}`) : null,
      adding ? kept("add", addCard) : null,
      list.length ? el("div", { class: "mk-reg-list" }, ...list.map(registryCard)) : el("div", { class: "card" }, el("div", { class: "card-body" }, "No registry is configured, so the marketplace indexes nothing. Add registry names one.")),
      state.orphans.length ? el("div", { class: "mk-reg-list" }, heading("Keys without a registry", "held for a repository no registry names"), ...state.orphans.map(orphanCard)) : null,
      el("p", { class: "panel-hint" }, "The list is @thetis/marketplace's registries setting, written whole on every change; the service restarts and refreshes from it. A registry uses SSH exactly when a repository key is held for its url; no setting says so. The key belongs to this installation, not to a person, and the system workspace offers it for that repository and no other. The command line has the same: thetis repo-key generate <url>.")
    );
  }

  void load();
  return () => {
    alive = false;
  };
}
