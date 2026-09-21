/* The README tab: the package's README.md, from `package-readme`, rendered by the shell's markdown. A
 * package without one says so. Relative images are shown as their alt text: the page has no resolver
 * for a package's files. */

export function mountReadme(ext, host, ctx) {
  const { el, clear } = ext.dom;
  const { busy, put } = ext.ui;
  let alive = true;
  const wrap = el("div", { class: "card ua-readme" }, el("div", { class: "card-head" }, `README · ${ctx.name}`));
  const body = el("div", { class: "card-body ua-readme-body" });
  wrap.append(body);
  host.append(wrap);
  void (async () => {
    const stop = busy(wrap, "Reading…");
    let text = null;
    try {
      text = (await ext.request("package-readme", { args: { name: ctx.name } }))?.data?.text ?? null;
    } catch (err) {
      if (!alive) return;
      clear(body);
      return void put(body, el("p", { class: "text-faint" }, `The README could not be read: ${err.message}`));
    } finally {
      stop();
    }
    if (!alive) return;
    clear(body);
    put(body, typeof text === "string" && text.trim() ? el("div", { class: "md" }, ...ext.markdown(text)) : el("p", { class: "text-faint" }, "This package has no README."));
  })();
  return () => {
    alive = false;
  };
}
