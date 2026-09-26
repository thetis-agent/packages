/* SSH keys: which keys each person's workspace may use, and which hosts it may reach with them. An admin
 * works on one person at a time, from a picker; a user works on their own workspace only, with no picker
 * (the people list is an admin's), and the kernel pins every ssh verb they send to themselves. Either way: their keys as cards, each with its public half ready to copy and the
 * hosts it vouches for; New key and Import key open one form at the top. A grant names one key file on
 * the host; the kernel loads it into that person's own ssh-agent, so the fence signs with it and can
 * never read it. Every change sends the person's whole list through `ssh-set`, as the command line does;
 * the kernel closes that person's fence, which reopens with an agent holding the new list, so the page
 * says that before it sends, and when the change is to the signed-in admin's own grants it waits for its
 * own gateway to come back rather than calling the lost request a failure (the same settle as mounts).
 *
 * Known hosts are part of a grant but never required: the fence accepts a host it meets for the first
 * time and remembers its key, and refuses one whose key changed. Vouching for a host ahead of time pins
 * its key from the start; the page finds the lines with `ssh-scan` (ssh-keyscan, run inside this fence)
 * rather than asking anyone to paste them. Nothing here is about one service: a key goes wherever this workspace should be let in, a code
 * host's account or a server's authorized_keys, and the connection check takes any user@host. Private key
 * material is sent once, to `ssh-import`, and never drawn again.
 *
 * A key the host made or took in for a person lives in their own key directory (`<home>/fence-keys/<id>/`).
 * A key anywhere else was granted by an admin: a user may revoke it but not grant it again, because the
 * kernel refuses a user any key path outside that directory that is not already theirs, so the card says
 * that before they find out. */

import { isLost } from "./workspaces.js";

/** The first token of a known_hosts line: the host name it vouches for. */
export function hostOfLine(line) {
  return String(line || "").trim().split(/\s+/)[0]?.split(",")[0] ?? "";
}

/** The host names a grant vouches for, once each, in order. */
export function hostsOf(grant) {
  return [...new Set((grant.hosts ?? []).map(hostOfLine).filter(Boolean))];
}

/** A key's short name: the file's name under its directory. */
export const keyName = (path) => String(path || "").split("/").filter(Boolean).at(-1) ?? "";

/** Whether a key file is one the host keeps for this person (made or imported), rather than one an admin granted. */
export function isOwnKey(path, user) {
  return Boolean(user) && String(path || "").includes(`/fence-keys/${user}/`);
}

/** What a connection attempt's words mean, in one sentence, and its tone. */
export function verdictOf(code, output) {
  const text = String(output || "");
  if (/successfully authenticated|welcome/i.test(text) || code === 0) return { tone: "ok", text: "Let in: the far end accepted a key from this workspace." };
  if (/permission denied/i.test(text)) return { tone: "warn", text: "Reached, but refused: the far end does not know any of this workspace's keys yet. Register a public key there." };
  if (/host key verification failed|no .*known_hosts|not in the list of known hosts/i.test(text)) return { tone: "err", text: "Not trusted: no known_hosts line vouches for this host. Add the host to a key." };
  if (/could not resolve|connection timed out|connection refused|network is unreachable|timed out/i.test(text)) return { tone: "err", text: "Not reached: the host did not answer from this workspace." };
  return { tone: "err", text: `ssh ended with code ${code ?? "?"}.` };
}

export function mountSsh(ext, root, who = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, field, heading, put } = ext.ui;
  const me = who.user ?? null;
  const self = who.role === "user"; // a user's own keys only: no picker, every change to their own workspace
  let people = [];
  let byUser = {}; // user -> [{ key, hosts?, present, publicKey, fingerprint }]
  let person = "";
  let form = null; // "new" | "import" | null: the one form open at the top
  let opened = null; // { key, publicKey, fingerprint } of a key just made or imported, shown first
  let addingTo = null; // the key whose host box is open
  const wrap = el("div", { class: "panel-col ua-ssh" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const grantsOf = (user) => byUser[user] ?? [];
  const sent = (grants) => grants.map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: g.hosts } : {}) }));

  async function load() {
    const stop = busy(wrap, "Reading the keys…");
    try {
      if (self) {
        const list = await ext.request("ssh-list", { args: { user: me } });
        people = [{ id: me }];
        byUser = list.data && typeof list.data === "object" ? list.data : {};
      } else {
        const [users, list] = await Promise.all([ext.request("users"), ext.request("ssh-list")]);
        people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
        byUser = list.data && typeof list.data === "object" ? list.data : {};
      }
      if (!person || !people.some((p) => p.id === person)) person = people.some((p) => p.id === me) ? me : (people[0]?.id ?? "");
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      stop();
    }
    draw();
  }

  /** Waits for the gateway to answer after its own fence was closed, up to half a minute. */
  async function settle(deadline = Date.now() + 30_000) {
    for (;;) {
      try {
        await ext.request("ssh-list", self ? { args: { user: me } } : undefined);
        return;
      } catch {
        if (Date.now() >= deadline) return;
        await new Promise((done) => setTimeout(done, 700));
      }
    }
  }

  /**
   * One request that changes a person's grants. The sentence names what reopens. Changing your own grants
   * closes the fence this page is served from, so the request can be lost: the page waits for the new one
   * to answer rather than calling that a failure. A refusal from a gateway still there is a refusal, though:
   * only a request that lost its gateway is waited for. `after(data)` reads the answer, and runs with null when the answer was lost.
   */
  async function change(verb, args, done, after) {
    try {
      const out = await ext.request(verb, { args });
      after?.(out?.data);
      ext.toast(done, { tone: "good" });
    } catch (err) {
      if (args.user !== me || !isLost(err)) return void ext.toast(err.message, { tone: "error" });
      // The change went through and its answer was lost with the gateway: the form closes and a private key's
      // material leaves the page all the same; only the key just made is not shown first, since nobody heard it.
      after?.(null);
      ext.toast(`${done} Waiting for the workspace to answer again…`, { tone: "good" });
      await settle();
    }
    await load();
  }

  const reopens = (u) => (self ? "Your workspace closes and reopens with the change; your services restart and this page reconnects." : `${u}'s workspace closes and reopens with the change; its services restart.${u === me ? " This page reconnects." : ""}`);
  /** Who a confirm names: the person for an admin, and nobody for a user acting on their own workspace. */
  const whoLine = () => (self ? [] : [["person", person]]);
  /** The done sentence's tail: "for bob" for an admin, nothing for a user. */
  const forWhom = () => (self ? "" : ` for ${person}`);

  async function revoke(anchor, grant) {
    const granted = self && !isOwnKey(grant.key, me);
    const ok = await confirm(anchor, { title: "Revoke this key?", lines: [...whoLine(), ["key", keyName(grant.key)], ["fingerprint", grant.fingerprint || "unknown"]], note: `${reopens(person)} The key file stays where it is.${granted ? " An admin granted this key; only an admin can grant it again." : ""}`, confirmLabel: "Revoke", tone: "warn" });
    if (!ok) return;
    await change("ssh-set", { user: person, ssh: sent(grantsOf(person).filter((g) => g.key !== grant.key)) }, `${keyName(grant.key)} was revoked${forWhom()}.`);
  }

  async function setHosts(anchor, grant, lines, said) {
    const next = grantsOf(person).map((g) => (g.key === grant.key ? { ...g, hosts: lines } : g));
    const ok = await confirm(anchor, { title: said.title, lines: [...whoLine(), ["key", keyName(grant.key)], ["hosts", [...new Set(lines.map(hostOfLine))].join(", ") || "none"]], note: reopens(person), confirmLabel: said.label, tone: said.tone });
    if (!ok) return;
    addingTo = null;
    await change("ssh-set", { user: person, ssh: sent(next) }, said.done);
  }

  /**
   * The known-hosts editor: a host to look up, Scan, and the lines found kept as chips by host name.
   * Used by both forms and by a key's own host box, so hosts are added the same way everywhere.
   */
  function hostsEditor(initial = []) {
    let lines = [...initial];
    const chips = el("div", { class: "ua-chips" });
    const input = el("input", { class: "input ua-host", type: "text", placeholder: "host, or host:port", "aria-label": "Host", autocomplete: "off", spellcheck: "false" });
    const note = el("span", { class: "text-faint ua-scan-note" });
    const drawChips = () => {
      clear(chips);
      const names = [...new Set(lines.map(hostOfLine).filter(Boolean))];
      if (!names.length) chips.append(el("span", { class: "text-faint" }, "none yet"));
      for (const name of names) {
        const off = button("×", { title: `Forget ${name}`, onClick: () => { lines = lines.filter((l) => hostOfLine(l) !== name); drawChips(); } });
        off.setAttribute("aria-label", `Forget ${name}`);
        off.classList.add("ua-chip-x");
        chips.append(el("span", { class: "ua-chip" }, el("code", {}, name), off));
      }
    };
    const scan = button("Scan", {
      title: "ssh-keyscan runs inside this workspace and returns the host's public keys",
      onClick: async () => {
        const value = input.value.trim();
        if (!value) return input.focus();
        scan.disabled = true;
        note.textContent = `asking ${value}…`;
        try {
          const out = await ext.request("ssh-scan", { args: { host: value } });
          const found = Array.isArray(out?.data?.lines) ? out.data.lines : [];
          lines = [...new Set([...lines, ...found])];
          note.textContent = found.length ? `${found.length} key${found.length === 1 ? "" : "s"} for ${out?.data?.host ?? value}` : `${value} answered with no keys`;
          input.value = "";
          drawChips();
        } catch (err) {
          note.textContent = err.message;
        } finally {
          scan.disabled = false;
        }
      },
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        scan.click();
      }
    });
    drawChips();
    const node = el("div", { class: "ua-hosts" }, el("div", { class: "row" }, input, scan, note), chips);
    return { node, lines: () => lines, focus: () => input.focus() };
  }

  /** The public half of a key: the line, ready to copy, and where it goes. */
  function publicKeyLine(grant) {
    if (!grant.publicKey) return el("span", { class: "text-faint" }, "The public half is not on the host beside this key.");
    const box = el("input", { class: "input ua-pubkey", type: "text", readonly: "", "aria-label": "Public key", spellcheck: "false" });
    box.value = grant.publicKey;
    box.addEventListener("focus", () => box.select());
    const copy = button("Copy", { onClick: () => navigator.clipboard?.writeText(box.value).then(() => ext.toast("Copied.", { tone: "good" }), () => { box.focus(); ext.toast("Select the line and copy it.", { tone: "error" }); }) });
    return el("div", { class: "row ua-pubkey-row" }, box, copy);
  }

  function keyCard(grant) {
    const hosts = hostsOf(grant);
    const fresh = opened?.key === grant.key;
    const revokeBtn = button("Revoke", { tone: "warn", onClick: () => void revoke(revokeBtn, grant) });
    const addBtn = button(addingTo === grant.key ? "Done" : "Add host", { onClick: () => { addingTo = addingTo === grant.key ? null : grant.key; draw(); } });
    const forget = (name) => {
      const off = button("×", { title: `Stop vouching for ${name}`, onClick: () => void setHosts(off, grant, (grant.hosts ?? []).filter((l) => hostOfLine(l) !== name), { title: `Stop vouching for ${name}?`, label: "Remove", tone: "warn", done: `${keyName(grant.key)} no longer vouches for ${name}.` }) });
      off.setAttribute("aria-label", `Stop vouching for ${name}`);
      off.classList.add("ua-chip-x");
      return off;
    };
    let addBox = null;
    if (addingTo === grant.key) {
      const editor = hostsEditor();
      const add = button("Add these hosts", { tone: "primary", onClick: () => { const lines = editor.lines(); if (!lines.length) return ext.toast("Scan a host first.", { tone: "error" }); void setHosts(add, grant, [...new Set([...(grant.hosts ?? []), ...lines])], { title: "Vouch for these hosts?", label: "Add", tone: "primary", done: `${keyName(grant.key)} may reach ${[...new Set(lines.map(hostOfLine))].join(", ")}${forWhom()}.` }); } });
      addBox = el("div", { class: "ua-addhost" }, editor.node, el("div", { class: "row" }, add));
    }
    return el(
      "div",
      { class: `card ua-key${fresh ? " is-fresh" : ""}`, "data-key": grant.key },
      el(
        "div",
        { class: "card-head ua-key-head" },
        el("code", { class: "ua-key-name" }, keyName(grant.key)),
        grant.fingerprint ? el("code", { class: "ua-fp" }, grant.fingerprint) : el("span", { class: "text-faint" }, "fingerprint unknown"),
        grant.present === false ? badge("not on the host", "err") : null,
        !hosts.length ? badge("no vouched hosts", "dim") : null,
        fresh ? badge("new", "accent") : null,
        el("span", { class: "toolbar-gap" }),
        revokeBtn
      ),
      el(
        "div",
        { class: "card-body ua-key-body" },
        el("div", { class: "ua-key-row" }, el("span", { class: "ua-key-label" }, "Public key"), el("div", { class: "ua-key-value" }, publicKeyLine(grant), el("p", { class: "text-faint" }, "Register this line wherever the workspace should be let in: a code host's account, or a server's authorized_keys. The private half stays with the kernel."))),
        el("div", { class: "ua-key-row" }, el("span", { class: "ua-key-label" }, "Known hosts"), el("div", { class: "ua-key-value" }, el("div", { class: "ua-chips" }, ...(hosts.length ? hosts.map((name) => el("span", { class: "ua-chip" }, el("code", {}, name), forget(name))) : [el("span", { class: "text-faint" }, "none vouched: a host met for the first time is accepted and remembered; one whose key changes is refused")]), addBtn), addBox)),
        el("div", { class: "ua-key-row" }, el("span", { class: "ua-key-label" }, "File"), el("div", { class: "ua-key-value" }, el("code", { class: "ua-wrap text-faint" }, grant.key), self && !isOwnKey(grant.key, me) ? el("p", { class: "text-faint" }, "Granted by an admin; you can revoke it but not re-grant it.") : null))
      )
    );
  }

  /** The one form at the top: New key (hosts only) or Import key (name, the private key, hosts). */
  function formCard() {
    const editor = hostsEditor();
    const cancel = button("Cancel", { onClick: () => { form = null; draw(); } });
    if (form === "new") {
      const go = button("Make the key", { tone: "primary", onClick: () => void generate() });
      async function generate() {
        const hosts = editor.lines();
        const ok = await confirm(go, { title: self ? "Make yourself a key?" : `Make a key for ${person}?`, lines: [...whoLine(), ["hosts", [...new Set(hosts.map(hostOfLine))].join(", ") || "none yet"]], note: `${self ? "The kernel makes you an ed25519 key of your own and grants it to your workspace." : `The kernel makes ${person} an ed25519 key of their own and grants it.`} A key already made is kept, not replaced. ${reopens(person)}`, confirmLabel: "Make it" });
        if (!ok) return;
        go.disabled = true;
        try {
          await change("ssh-keygen", { user: person, hosts }, `A key was made${forWhom()}.`, (data) => { form = null; if (data?.key) opened = { key: data.key, publicKey: data.publicKey, fingerprint: data.fingerprint }; });
        } finally {
          go.disabled = false;
        }
      }
      return el("div", { class: "card ua-form" }, el("div", { class: "card-head" }, self ? "New key" : `New key for ${person}`), el("div", { class: "card-body" }, el("p", { class: "text-faint" }, self ? "A key of your own, made by the kernel. Its public half is shown afterwards to register at the far end; the private half stays with the kernel, where your workspace uses it and cannot read it." : "No credential is lent: the person gets a key of their own. Its public half is shown afterwards to register at the far end; the private half stays with the kernel."), field("Hosts it may reach", editor.node, "Scan each host now or add them to the key later."), el("div", { class: "row" }, go, cancel)));
    }
    const name = el("input", { class: "input", type: "text", placeholder: "deploy", "aria-label": "Key name", autocomplete: "off", spellcheck: "false", maxlength: "64" });
    const material = el("textarea", { class: "input ua-material", rows: "7", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----", "aria-label": "Private key", spellcheck: "false", autocomplete: "off" });
    const go = button("Import the key", { tone: "primary", onClick: () => void upload() });
    async function upload() {
      const key = name.value.trim();
      const text = material.value;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) return ext.toast("A key name is lowercase letters, digits, dots, dashes and underscores.", { tone: "error" }), name.focus();
      if (!text.trim() || !text.includes("PRIVATE KEY")) return ext.toast("Paste the whole private key, BEGIN and END lines included.", { tone: "error" }), material.focus();
      const hosts = editor.lines();
      const ok = await confirm(go, { title: self ? "Import this key?" : `Import a key for ${person}?`, lines: [...whoLine(), ["name", key], ["hosts", [...new Set(hosts.map(hostOfLine))].join(", ") || "none yet"]], note: `The key is sent once, over this page's connection, and kept by the kernel where ${self ? "your workspace" : `${person}'s fence`} cannot read it. ${reopens(person)}`, confirmLabel: "Import" });
      if (!ok) return;
      go.disabled = true;
      try {
        await change("ssh-import", { user: person, name: key, privateKey: text, hosts }, `${key} was imported${forWhom()}.`, (data) => { material.value = ""; form = null; if (data?.key) opened = { key: data.key, publicKey: data.publicKey, fingerprint: data.fingerprint }; });
      } finally {
        go.disabled = false;
      }
    }
    return el("div", { class: "card ua-form" }, el("div", { class: "card-head" }, self ? "Import a key" : `Import a key for ${person}`), el("div", { class: "card-body" }, el("div", { class: "ua-form-grid" }, field("Name", name, "A plain name; the file lands beside the generated key."), field("Private key", material, "Sent once over this page's connection; a key with a passphrase is refused, since nothing in the fence can answer a prompt.")), field("Hosts it may reach", editor.node), el("div", { class: "row" }, go, cancel)));
  }

  /** A connection attempt from the admin's own workspace, to any user@host: what the far end said, and what that means. */
  function tryCard() {
    const target = el("input", { class: "input ua-host", type: "text", placeholder: "user@host, or user@host:port", "aria-label": "Target", autocomplete: "off", spellcheck: "false" });
    const out = el("div", { class: "ua-try-out", hidden: true });
    const go = button("Try", { tone: "primary", onClick: () => void attempt() });
    async function attempt() {
      const value = target.value.trim();
      if (!/^[a-z0-9._-]+@[a-z0-9.-]+(:\d{1,5})?$/i.test(value)) return ext.toast("A target is user@host, with an optional :port.", { tone: "error" }), target.focus();
      go.disabled = true;
      out.hidden = false;
      clear(out);
      put(out, el("span", { class: "text-faint" }, `ssh -T ${value} …`));
      try {
        const r = (await ext.request("ssh-test", { args: { target: value } }))?.data ?? {};
        const v = verdictOf(r.code, r.output);
        clear(out);
        put(out, badge(v.tone === "ok" ? "let in" : v.tone === "warn" ? "refused" : "failed", v.tone), el("p", { class: "ua-verdict" }, v.text), r.output ? el("pre", { class: "ua-try-pre" }, r.output) : null);
      } catch (err) {
        clear(out);
        put(out, badge("failed", "err"), el("p", { class: "ua-verdict" }, err.message));
      } finally {
        go.disabled = false;
      }
    }
    target.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go.click();
      }
    });
    return el("div", { class: "card ua-try" }, el("div", { class: "card-head" }, "Try a connection", el("span", { class: "text-faint ua-head-note" }, "from your own workspace, with your keys")), el("div", { class: "card-body" }, el("div", { class: "row" }, target, go), out));
  }

  function draw() {
    clear(wrap);
    const picker = self ? null : el("select", { class: "input", "aria-label": "Person", onChange: () => { person = picker.value; form = null; opened = null; addingTo = null; draw(); } }, ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id}${p.id === me ? " (me)" : ""} · ${grantsOf(p.id).length} ${grantsOf(p.id).length === 1 ? "key" : "keys"}`)));
    const grants = [...grantsOf(person)].sort((a, b) => (opened?.key === a.key ? -1 : opened?.key === b.key ? 1 : 0));
    const newBtn = button("New key", { tone: form === "new" ? "quiet" : "primary", onClick: () => { form = form === "new" ? null : "new"; draw(); } });
    const importBtn = button("Import key", { onClick: () => { form = form === "import" ? null : "import"; draw(); } });
    put(
      wrap,
      el("div", { class: "toolbar" }, heading(self ? "Your SSH keys" : "SSH keys", self ? `${grants.length} ${grants.length === 1 ? "key" : "keys"}` : people.length ? `${grants.length} ${grants.length === 1 ? "key" : "keys"} for ${person}` : null), el("div", { class: "toolbar-gap" }), picker ? el("label", { class: "ua-line" }, el("span", { class: "text-faint" }, "Person"), picker) : null, newBtn, importBtn),
      form ? formCard() : null,
      grants.length ? el("div", { class: "ua-keys" }, ...grants.map(keyCard)) : el("div", { class: "card ua-empty" }, el("div", { class: "card-body" }, self ? "Your workspace has no key. New key makes one for it; Import key takes one you already have." : people.length ? `${person}'s workspace has no key. New key makes one for it; Import key takes one that already exists.` : "No person has a workspace here.")),
      person === me ? tryCard() : null,
      self
        ? el("p", { class: "panel-hint" }, "A grant names one key file, never a directory: your workspace gets the use of that key through its own ssh-agent and cannot copy it. A change closes your workspace; it reopens with the new keys and known hosts, your services restart, and this page reconnects.")
        : el("p", { class: "panel-hint" }, "A grant names one key file, never a directory: the person's fence gets the use of that key through its own ssh-agent and cannot copy it. A change closes the person's fence; it reopens on their next request with the new keys and known hosts, and their services restart."),
      self ? null : el("p", { class: "panel-hint" }, "These are people's keys. A private registry's key belongs to the installation and is managed under Marketplace → Registries.")
    );
  }

  void load();
}
