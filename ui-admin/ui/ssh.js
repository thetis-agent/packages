/* SSH keys: which keys each person's workspace may use, and where they may go. One person at a time, from
 * a picker: their grants as a table, and under it the two ways a key comes to be — the kernel makes one
 * for them, or one they already have is uploaded. A grant names one key file on the host; the kernel
 * loads it into that person's own ssh-agent, so the fence signs with it and can never read it. Every
 * change sends the person's whole list through `ssh-set`, as the command line does; the kernel closes
 * that person's fence, which reopens with an agent holding the new list, so the page says that before it
 * sends, and when the change is to the signed-in admin's own grants it waits for its own gateway to come
 * back rather than calling the lost request a failure (the same settle as the mounts section).
 *
 * A key with no vouched-for host cannot connect to anything: StrictHostKeyChecking is on inside the fence
 * and there is nobody there to answer a prompt. So known hosts are part of a grant, and the page finds
 * their lines with `ssh-scan` (ssh-keyscan, run inside this fence) rather than asking anyone to paste
 * them. The public half of a key is shown with a copy button and the sentence about where it goes, since
 * registering it at the far end is the half of the job the kernel cannot do. Private key material is sent
 * once, to `ssh-import`, and never drawn again. */

/** The first token of a known_hosts line: the host name it vouches for. */
export function hostOfLine(line) {
  return String(line || "").trim().split(/\s+/)[0]?.split(",")[0] ?? "";
}

/** The host names a grant vouches for, once each, in order. */
export function hostsOf(grant) {
  return [...new Set((grant.hosts ?? []).map(hostOfLine).filter(Boolean))];
}

/** A key's short name for the table: the file's name under its directory. */
export const keyName = (path) => String(path || "").split("/").filter(Boolean).at(-1) ?? "";

export function mountSsh(ext, root, who = {}) {
  const { el, clear } = ext.dom;
  const { badge, busy, button, confirm, field, heading, put, table } = ext.ui;
  const me = who.user ?? null;
  let people = [];
  let byUser = {}; // user -> [{ key, hosts?, present, publicKey, fingerprint }]
  let person = "";
  let shown = null; // { key, publicKey } of the public key panel open under the table
  let adding = null; // the key whose "add host" form is open
  const wrap = el("div", { class: "panel-col ua-ssh" });
  root.append(el("div", { class: "panel-cols" }, wrap));

  const grantsOf = (user) => byUser[user] ?? [];

  async function load() {
    const stop = busy(wrap, "Reading the keys…");
    try {
      const [users, list] = await Promise.all([ext.request("users"), ext.request("ssh-list")]);
      people = (Array.isArray(users.data) ? users.data : []).filter((p) => p.role !== "system");
      byUser = list.data && typeof list.data === "object" ? list.data : {};
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
        await ext.request("ssh-list");
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
   * to answer rather than calling that a failure. `after(data)` reads the answer when there is one.
   */
  async function change(verb, args, done, after) {
    try {
      const out = await ext.request(verb, { args });
      after?.(out?.data);
      ext.toast(done, { tone: "good" });
    } catch (err) {
      if (args.user !== me) return void ext.toast(err.message, { tone: "error" });
      ext.toast(`${done} Waiting for the workspace to answer again…`, { tone: "good" });
      await settle();
    }
    await load();
  }

  const sent = (user, grants) => grants.map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: g.hosts } : {}) }));

  async function revoke(anchor, grant) {
    const ok = await confirm(anchor, { title: "Revoke this key?", lines: [["person", person], ["key", grant.key]], note: `${person}'s fence reopens without it; their services restart. The file stays where it is.`, confirmLabel: "Revoke", tone: "warn" });
    if (!ok) return;
    await change("ssh-set", { user: person, ssh: sent(person, grantsOf(person).filter((g) => g.key !== grant.key)) }, `${keyName(grant.key)} was revoked for ${person}.`);
  }

  async function addHosts(anchor, grant, lines) {
    if (!lines.length) return ext.toast("Scan a host first.", { tone: "error" });
    const ok = await confirm(anchor, { title: "Vouch for these hosts?", lines: [["person", person], ["key", keyName(grant.key)], ["hosts", [...new Set(lines.map(hostOfLine))].join(", ")]], note: `${person}'s fence reopens with the lines in its known_hosts.`, confirmLabel: "Add" });
    if (!ok) return;
    const next = grantsOf(person).map((g) => (g.key === grant.key ? { ...g, hosts: [...new Set([...(g.hosts ?? []), ...lines])] } : g));
    adding = null;
    await change("ssh-set", { user: person, ssh: sent(person, next) }, `${keyName(grant.key)} may reach ${[...new Set(lines.map(hostOfLine))].join(", ")} for ${person}.`);
  }

  /** The lines ssh-keyscan finds for a host, shown under the box they were asked for. */
  function scanner(onLines) {
    const host = el("input", { class: "input ua-host", type: "text", placeholder: "github.com", "aria-label": "Host", autocomplete: "off", spellcheck: "false" });
    const found = el("div", { class: "ua-scan-found", hidden: true });
    let lines = [];
    const scan = button("Scan", {
      onClick: async () => {
        const value = host.value.trim();
        if (!value) return host.focus();
        scan.disabled = true;
        try {
          const out = await ext.request("ssh-scan", { args: { host: value } });
          lines = Array.isArray(out?.data?.lines) ? out.data.lines : [];
          clear(found);
          found.hidden = false;
          put(found, el("span", { class: "text-faint" }, `${lines.length} known_hosts line${lines.length === 1 ? "" : "s"} for ${out?.data?.host ?? value}:`), ...lines.map((l) => el("code", { class: "ua-wrap ua-hostline" }, l)));
          onLines?.(lines);
        } catch (err) {
          lines = [];
          found.hidden = false;
          clear(found);
          put(found, el("span", { class: "ua-refused" }, err.message));
          onLines?.(lines);
        } finally {
          scan.disabled = false;
        }
      },
    });
    host.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        scan.click();
      }
    });
    return { host, scan, found, lines: () => lines };
  }

  /** The public half of a key, with the sentence about where it goes and a button that copies it. */
  function publicKeyPanel(title, publicKey, fingerprint) {
    const box = el("textarea", { class: "input ua-pubkey", rows: "3", readonly: "", "aria-label": "Public key", spellcheck: "false" });
    box.value = publicKey || "";
    const copy = button("Copy", { onClick: () => { box.select(); navigator.clipboard?.writeText(box.value).then(() => ext.toast("Copied.", { tone: "good" }), () => ext.toast("Could not copy; select the line and copy it.", { tone: "error" })); } });
    return el(
      "div",
      { class: "card ua-pubkey-card" },
      el("div", { class: "card-head" }, title, fingerprint ? el("code", { class: "ua-fp" }, fingerprint) : null, el("span", { class: "toolbar-gap" }), copy),
      el("div", { class: "card-body ua-code" }, publicKey ? box : el("span", { class: "text-faint" }, "The public half is not on the host beside this key."), el("p", { class: "text-faint" }, "Add it at github.com/settings/keys as an authentication key, or wherever this workspace should be let in. The private half stays with the kernel."))
    );
  }

  function row(grant) {
    const hosts = hostsOf(grant);
    const showBtn = button("Show public key", { onClick: () => { shown = shown?.key === grant.key ? null : { key: grant.key, publicKey: grant.publicKey, fingerprint: grant.fingerprint }; draw(); } });
    const hostBtn = button("Add host", { onClick: () => { adding = adding === grant.key ? null : grant.key; draw(); } });
    const revokeBtn = button("Revoke", { tone: "warn", onClick: () => void revoke(revokeBtn, grant) });
    return el("div", { class: "ua-ssh-actions" }, showBtn, hostBtn, revokeBtn);
  }

  /** The form under a row: scan a host, then add its lines to that grant. */
  function addHostBlock(grant) {
    const s = scanner();
    const add = button("Add", { tone: "primary", onClick: () => void addHosts(add, grant, s.lines()) });
    return el("div", { class: "card ua-add ua-addhost" }, el("div", { class: "card-head" }, `Vouch for a host with ${keyName(grant.key)}`), el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Host", s.host), s.scan, add), s.found, el("p", { class: "text-faint" }, "ssh-keyscan runs inside this workspace and returns the host's public keys; the fence then trusts that host and no other. Without a line for it, ssh refuses the connection in a second.")));
  }

  function keygenBlock() {
    const s = scanner();
    const go = button("Generate a key", { tone: "primary", onClick: () => void generate() });
    async function generate() {
      const hosts = s.lines();
      const ok = await confirm(go, { title: "Make a key for this person?", lines: [["person", person], ["hosts", hosts.length ? [...new Set(hosts.map(hostOfLine))].join(", ") : "none yet"]], note: `The kernel makes ${person} an ed25519 key of their own and grants it; their fence reopens with it. A key already made is kept, not replaced.`, confirmLabel: "Generate" });
      if (!ok) return;
      go.disabled = true;
      try {
        await change("ssh-keygen", { user: person, hosts }, `A key was made for ${person}.`, (data) => { if (data?.publicKey) shown = { key: data.key, publicKey: data.publicKey, fingerprint: data.fingerprint }; });
      } finally {
        go.disabled = false;
      }
    }
    return el("div", { class: "card add-block ua-add" }, el("div", { class: "card-head" }, "Generate a key"), el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Host to vouch for", s.host), s.scan, go), s.found, el("p", { class: "text-faint" }, "No host credential is lent: the person gets a key of their own, the public half is shown to register at the far end, and the private half stays with the kernel. Revoking is per person and visible at the far end as which key stopped pushing.")));
  }

  function importBlock() {
    const name = el("input", { class: "input", type: "text", placeholder: "github", "aria-label": "Key name", autocomplete: "off", spellcheck: "false", maxlength: "64" });
    const material = el("textarea", { class: "input ua-material", rows: "6", placeholder: "-----BEGIN OPENSSH PRIVATE KEY-----", "aria-label": "Private key", spellcheck: "false", autocomplete: "off" });
    const s = scanner();
    const go = button("Upload the key", { tone: "primary", onClick: () => void upload() });
    async function upload() {
      const key = name.value.trim();
      const text = material.value;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(key)) return ext.toast("A key name is lowercase letters, digits, dots, dashes and underscores.", { tone: "error" }), name.focus();
      if (!text.trim() || !text.includes("PRIVATE KEY")) return ext.toast("Paste the whole private key, BEGIN and END lines included.", { tone: "error" }), material.focus();
      const hosts = s.lines();
      const ok = await confirm(go, { title: "Upload this key?", lines: [["person", person], ["name", key], ["hosts", hosts.length ? [...new Set(hosts.map(hostOfLine))].join(", ") : "none yet"]], note: `The key is sent once, over this page's connection, and kept by the kernel where ${person}'s fence cannot read it; the fence reopens with an agent holding it.`, confirmLabel: "Upload" });
      if (!ok) return;
      go.disabled = true;
      try {
        await change("ssh-import", { user: person, name: key, privateKey: text, hosts }, `${key} was uploaded for ${person}.`, (data) => { material.value = ""; if (data?.publicKey) shown = { key: data.key, publicKey: data.publicKey, fingerprint: data.fingerprint }; });
      } finally {
        go.disabled = false;
      }
    }
    return el("div", { class: "card add-block ua-add" }, el("div", { class: "card-head" }, "Upload a key"), el("div", { class: "card-body" }, el("div", { class: "row wrap" }, field("Name", name), field("Host to vouch for", s.host), s.scan), field("Private key", material, "Sent once over this page's connection and stored by the kernel where the fence cannot read it. Prefer a key made for this workspace alone."), s.found, el("div", { class: "row" }, go)));
  }

  async function test(anchor, host) {
    anchor.disabled = true;
    try {
      const out = await ext.request("ssh-test", { args: { host } });
      const { code, output } = out?.data ?? {};
      const greeted = /successfully authenticated/i.test(output || "");
      const refused = /permission denied/i.test(output || "");
      ext.toast(greeted ? `${host} let this workspace in: ${output.split("\n")[0]}` : refused ? `${host} refused the key: it is not registered there yet. ${output.split("\n")[0]}` : `${host} answered ${code}: ${output || "nothing"}`, { tone: greeted ? "good" : refused ? "warn" : "error" });
    } catch (err) {
      ext.toast(err.message, { tone: "error" });
    } finally {
      anchor.disabled = false;
    }
  }

  function draw() {
    clear(wrap);
    const picker = el("select", { class: "input", "aria-label": "Person", onChange: () => { person = picker.value; shown = null; adding = null; draw(); } }, ...people.map((p) => el("option", { value: p.id, selected: p.id === person || null }, `${p.id}${p.id === me ? " (me)" : ""} · ${grantsOf(p.id).length} ${grantsOf(p.id).length === 1 ? "key" : "keys"}`)));
    const grants = grantsOf(person);
    const testBtn = person === me ? button("Test github.com", { title: "Runs ssh -T git@github.com inside your own workspace", onClick: () => void test(testBtn, "github.com") }) : null;
    put(
      wrap,
      el("div", { class: "toolbar" }, heading("SSH keys", people.length ? `${grants.length} ${grants.length === 1 ? "key" : "keys"} for ${person}` : null), el("div", { class: "toolbar-gap" }), el("label", { class: "ua-line" }, el("span", { class: "text-faint" }, "Person"), picker), testBtn),
      table(
        [
          { key: "name", label: "Key", render: (g) => el("span", { class: "ua-code" }, el("code", {}, keyName(g.key)), el("span", { class: "text-faint ua-wrap" }, g.key)) },
          { key: "fingerprint", label: "Fingerprint", render: (g) => (g.fingerprint ? el("code", { class: "ua-fp" }, g.fingerprint) : el("span", { class: "text-faint" }, "—")) },
          { key: "state", label: "On the host", render: (g) => (g.present === undefined ? badge("not known", "dim") : g.present ? badge("present", "ok") : badge("not on the host", "err")) },
          { key: "hosts", label: "May reach", render: (g) => { const h = hostsOf(g); return h.length ? el("span", { class: "ua-line" }, ...h.map((x) => el("code", {}, x))) : badge("no hosts · refuses every connection", "warn"); } },
          { key: "actions", label: "", render: row },
        ],
        grants,
        { rowKey: (g) => g.key, empty: people.length ? `${person}'s workspace has no ssh key. Generate one below, or upload one.` : "No person has a workspace here." }
      ),
      shown ? publicKeyPanel(`Public key · ${keyName(shown.key)}`, shown.publicKey, shown.fingerprint) : null,
      adding && grants.some((g) => g.key === adding) ? addHostBlock(grants.find((g) => g.key === adding)) : null,
      people.length ? el("div", { class: "ua-ssh-forms" }, keygenBlock(), importBlock()) : null,
      el("p", { class: "panel-hint" }, "A grant names one key file, never a directory: the person's fence gets the use of that key through its own ssh-agent and cannot copy it. A change closes the person's fence; it reopens on their next request with the new keys and known hosts, and their services restart. Changing your own keys reopens this page. Test github.com runs in your own workspace, so it answers for your grants only.")
    );
  }

  void load();
}
