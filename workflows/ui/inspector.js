/* The inspector: a form for the selected step, one per type, with exactly the fields of the README's
 * "Steps" table, and with nothing selected the workflow's own fields. Edits write straight into the draft
 * and call `onChange(structural)`: the editor redraws the canvas and saves; `structural` also redraws this
 * form, for a change that adds or removes fields (a conversation switched to "new" grows a title). Typing
 * never redraws the field being typed in.
 *
 * Template fields share one variable tray at the foot of the form: it inserts `{{path}}` at the caret of
 * the template field that last had focus, and each template says which of its holes no step saves. */

import { positive } from "./format.js";
import { svgIcon } from "./icons.js";
import { FLOW_FIELDS, TYPES, fromList, isEnd, setFrom } from "./steps.js";
import { holes, insertHole, templateVariables, testParse } from "./templates.js";

const DEFAULT_NUDGE = "Budget reached. Stop exploring and finish now with what you have; say plainly what is unverified.";
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
let seq = 0;

/**
 * `s`: `{ def, selected, catalog, issues, samples, onChange, rename, remove, setStart, select }` where
 * `issues` is format.sortIssues' answer and `samples` a Map of parse test texts the editor keeps.
 */
export function renderInspector(ext, s) {
  const { el } = ext.dom;
  const def = s.def;
  const step = s.selected ? def.steps[s.selected] : null;
  const vars = templateVariables(def, s.selected);
  const known = new Set(vars.map((v) => v.path));
  let activeTemplate = null;
  const uid = () => `wf-f${++seq}`;

  /* --- field builders ----------------------------------------------------------------------- */

  const labelled = (label, control, hint, { wide = false } = {}) => {
    const id = control.id || (control.id = uid());
    return el("div", { class: `wf-field${wide ? " is-wide" : ""}` }, el("label", { class: "wf-field-label", for: id }, label), control, hint ? el("p", { class: "wf-field-hint" }, hint) : null);
  };

  function text(label, get, set, { placeholder, mono, hint, maxlength } = {}) {
    const input = el("input", { class: `input${mono ? " wf-mono" : ""}`, type: "text", placeholder, maxlength, spellcheck: "false" });
    input.value = get() ?? "";
    input.addEventListener("input", () => {
      set(input.value);
      s.onChange(false);
    });
    return labelled(label, input, hint);
  }

  function number(label, get, set, { placeholder, hint, min } = {}) {
    const input = el("input", { class: "input wf-mono", type: "text", inputmode: "decimal", placeholder, autocomplete: "off" });
    const v = get();
    input.value = v == null ? "" : String(v);
    const bad = el("p", { class: "wf-field-hint is-err", hidden: true });
    input.addEventListener("input", () => {
      const t = input.value.trim();
      const n = positive(t);
      bad.hidden = !t || (n !== undefined && (min == null || n >= min));
      bad.textContent = min != null ? `A number of at least ${min}.` : "A positive number.";
      set(t ? n : undefined);
      s.onChange(false);
    });
    const f = labelled(label, input, hint);
    f.append(bad);
    return f;
  }

  function select(label, options, get, set, { structural = false, hint } = {}) {
    const sel = el("select", { class: "input" }, ...options.map((o) => el("option", { value: o.value }, o.label)));
    sel.value = get() ?? "";
    if (sel.value !== (get() ?? "")) {
      // A value the options do not hold (a step that is gone, say): show it rather than pretend it is empty.
      sel.append(el("option", { value: get() }, `${get()} (missing)`));
      sel.value = get();
    }
    sel.addEventListener("change", () => {
      set(sel.value);
      s.onChange(structural);
    });
    return labelled(label, sel, hint);
  }

  const stepName = (id) => (def.steps[id]?.label && def.steps[id].label !== id ? `${def.steps[id].label} (${id})` : id);
  const stepOptions = (filter = () => true) => Object.keys(def.steps).filter((id) => id !== s.selected && filter(id, def.steps[id])).map((id) => ({ value: id, label: stepName(id) }));

  /** A select of the other steps for a flow field; empty means the engine's fallback, said in words. */
  function target(label, field, fallback) {
    return select(
      label,
      [{ value: "", label: `none (${fallback})` }, ...stepOptions()],
      () => step[field] ?? "",
      (v) => {
        if (v) step[field] = v;
        else delete step[field];
      }
    );
  }

  function template(label, get, set, { rows = 4, placeholder, hint, single = false } = {}) {
    const area = el("textarea", { class: `input wf-template${single ? " is-single" : ""}`, rows: String(single ? 1 : rows), placeholder, spellcheck: single ? "false" : "true", "data-template": "1" });
    area.value = get() ?? "";
    const warn = el("p", { class: "wf-field-hint is-warn", hidden: true });
    const check = () => {
      const unknown = holes(area.value).filter((h) => !known.has(h));
      warn.hidden = !unknown.length;
      warn.textContent = unknown.length ? `No step saves ${unknown.map((h) => `{{${h}}}`).join(", ")}; ${unknown.length === 1 ? "it renders" : "they render"} empty.` : "";
    };
    check();
    area.addEventListener("input", () => {
      set(area.value);
      check();
      s.onChange(false);
    });
    area.addEventListener("focus", () => {
      activeTemplate = area;
      tray.setTarget(label);
    });
    if (single) area.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
    const f = labelled(label, area, hint, { wide: true });
    f.append(warn);
    return f;
  }

  const section = (title, ...children) => el("section", { class: "wf-insp-section" }, title ? el("h3", { class: "wf-insp-h" }, title) : null, ...children.flat().filter(Boolean));

  /* --- the variable tray ---------------------------------------------------------------------- */

  const trayTarget = el("span", { class: "wf-tray-target" }, "Click into a template field first");
  const tray = {
    node: el(
      "div",
      { class: "wf-tray", role: "group", "aria-label": "Insert a variable" },
      el("div", { class: "wf-tray-head" }, el("span", { class: "wf-insp-h" }, "Insert variable"), trayTarget),
      el(
        "div",
        { class: "wf-tray-chips" },
        ...vars.map((v) =>
          el(
            "button",
            {
              type: "button",
              class: `wf-var${v.step ? "" : " is-run"}`,
              title: `Insert {{${v.path}}}`,
              onMousedown: (e) => e.preventDefault(), // keep the caret in the template
              onClick: () => {
                const area = activeTemplate;
                if (!area || !area.isConnected) return ext.toast("Click into a template field, then choose a variable.", { tone: "warn" });
                const out = insertHole(area.value, area.selectionStart, area.selectionEnd, v.path);
                area.value = out.text;
                area.dispatchEvent(new Event("input"));
                area.focus();
                area.setSelectionRange(out.caret, out.caret);
              },
            },
            `{{${v.path}}}`
          )
        )
      )
    ),
    setTarget(label) {
      trayTarget.textContent = `into ${label}`;
    },
  };

  /* --- issues for what is shown --------------------------------------------------------------- */

  function issueList(list) {
    if (!list.length) return null;
    return el(
      "ul",
      { class: "wf-insp-issues" },
      ...list.map((i) => el("li", { class: `wf-issue is-${i.level === "error" ? "err" : "warn"}` }, svgIcon(i.level === "error" ? "error" : "warn", { size: 13 }), el("span", {}, i.message)))
    );
  }

  /* --- per type ------------------------------------------------------------------------------- */

  function promptForm() {
    const models = s.catalog?.models ?? [];
    const inCatalog = models.some((m) => m.id === step.model);
    const other = el("input", { class: "input wf-mono", type: "text", placeholder: "provider/model id", "aria-label": "Model id", spellcheck: "false", hidden: inCatalog || !step.model ? true : false });
    other.value = inCatalog ? "" : step.model ?? "";
    other.hidden = inCatalog || (!step.model && models.length > 0);
    const sel = el(
      "select",
      { class: "input" },
      !step.model ? el("option", { value: "" }, "Choose a model") : null,
      ...models.map((m) => el("option", { value: m.id }, m.label ? `${m.label} · ${m.id}` : m.id)),
      el("option", { value: "__other" }, "Other…")
    );
    sel.value = inCatalog ? step.model : step.model ? "__other" : models.length ? "" : "__other";
    sel.addEventListener("change", () => {
      if (sel.value === "__other") {
        other.hidden = false;
        other.focus();
        step.model = other.value.trim();
      } else {
        other.hidden = true;
        step.model = sel.value;
      }
      s.onChange(false);
    });
    other.addEventListener("input", () => {
      step.model = other.value.trim();
      s.onChange(false);
    });
    const modelField = labelled("Model", sel, models.length ? null : "The catalog lists no models; type the id.");
    modelField.append(other);

    const conv = select(
      "Conversation",
      [{ value: "new", label: "A new conversation" }, ...stepOptions((id, st) => st.type === "prompt").map((o) => ({ value: o.value, label: `Continue ${o.label}` }))],
      () => step.conversation || "new",
      (v) => {
        step.conversation = v;
        if (v !== "new") delete step.title;
      },
      { structural: true, hint: "Continuing a conversation sends this prompt to it, on this step's model." }
    );

    const budget = step.budget ?? {};
    const setBudget = (k) => (v) => {
      const b = { ...(step.budget ?? {}) };
      if (v === undefined) delete b[k];
      else b[k] = v;
      if (Object.keys(b).length) step.budget = b;
      else delete step.budget;
    };

    return [
      section("Conversation", modelField, conv, (step.conversation || "new") === "new" ? template("Title", () => step.title, (v) => (v ? (step.title = v) : delete step.title), { single: true, placeholder: "The first line of the first message", hint: "What the conversation list shows." }) : null),
      section("Prompt", template("Prompt template", () => step.prompt, (v) => (step.prompt = v), { rows: 10, placeholder: "What to ask. {{input}} is the run's input." })),
      section(
        "Budget",
        el(
          "div",
          { class: "wf-grid3" },
          number("Tool calls", () => budget.toolCalls, setBudget("toolCalls"), { placeholder: "—" }),
          number("Context tokens", () => budget.tokens, setBudget("tokens"), { placeholder: "—" }),
          number("Minutes", () => budget.minutes, setBudget("minutes"), { placeholder: "—" })
        ),
        el("p", { class: "wf-field-hint" }, "On the first breach the turn is cancelled and the nudge is sent; on the second the run goes to On breach."),
        template("Nudge", () => step.nudge, (v) => (v ? (step.nudge = v) : delete step.nudge), { rows: 3, placeholder: DEFAULT_NUDGE })
      ),
      section("Then", target("Next", "next", "end as done"), target("On breach", "onBreach", "end as needs-you")),
    ];
  }

  function toolForm() {
    const tools = s.catalog?.tools ?? [];
    const idx = tools.findIndex((t) => t.package === step.package && t.export === step.export && t.name === step.name);
    const sel = el(
      "select",
      { class: "input" },
      el("option", { value: "" }, "Choose a tool"),
      ...tools.map((t, i) => el("option", { value: String(i) }, `${t.name} · ${t.package}`)),
      idx < 0 && step.name ? el("option", { value: "missing" }, `${step.name} · ${step.package || "?"} (not installed)`) : null
    );
    sel.value = idx >= 0 ? String(idx) : step.name ? "missing" : "";
    const desc = el("p", { class: "wf-field-hint" }, idx >= 0 ? tools[idx].description ?? "" : "");
    sel.addEventListener("change", () => {
      const t = tools[Number(sel.value)];
      if (sel.value === "" || !t) {
        if (sel.value === "") Object.assign(step, { package: "", export: "", name: "" });
      } else Object.assign(step, { package: t.package, export: t.export, name: t.name });
      desc.textContent = t?.description ?? "";
      s.onChange(false);
    });
    const toolField = labelled("Tool", sel);
    toolField.append(desc);

    const args = step.args && typeof step.args === "object" ? step.args : (step.args = {});
    const rows = el("div", { class: "wf-rows" });
    const drawArgs = () => {
      rows.replaceChildren(
        ...Object.keys(args).map((key) => {
          const k = el("input", { class: "input wf-mono", type: "text", "aria-label": "Argument name", spellcheck: "false" });
          k.value = key;
          k.addEventListener("change", () => {
            const nk = k.value.trim();
            if (!nk || nk === key || nk in args) return void (k.value = key);
            const entries = Object.entries(args).map(([a, b]) => [a === key ? nk : a, b]);
            for (const a of Object.keys(args)) delete args[a];
            Object.assign(args, Object.fromEntries(entries));
            s.onChange(false);
            drawArgs();
          });
          const v = el("textarea", { class: "input wf-template is-single", rows: "1", "aria-label": `Value of ${key}`, "data-template": "1", spellcheck: "false" });
          v.value = typeof args[key] === "string" ? args[key] : JSON.stringify(args[key]);
          v.addEventListener("input", () => {
            args[key] = v.value;
            s.onChange(false);
          });
          v.addEventListener("focus", () => {
            activeTemplate = v;
            tray.setTarget(`argument ${key}`);
          });
          const rm = el("button", { type: "button", class: "wf-icon-btn", "aria-label": `Remove argument ${key}`, title: "Remove", onClick: () => { delete args[key]; s.onChange(false); drawArgs(); } }, svgIcon("x", { size: 12 }));
          return el("div", { class: "wf-row" }, k, v, rm);
        })
      );
    };
    drawArgs();
    const add = el("button", { type: "button", class: "btn is-quiet wf-btn wf-add" }, svgIcon("plus", { size: 12 }), "Add argument");
    add.addEventListener("click", () => {
      let n = 1;
      while (`arg${n}` in args) n++;
      args[`arg${n}`] = "";
      s.onChange(false);
      drawArgs();
      rows.lastElementChild?.querySelector("input")?.select();
    });
    return [
      section("Tool", toolField),
      section("Arguments", el("p", { class: "wf-field-hint" }, "String values are templates."), rows, add),
      section("Then", target("Next", "next", "end as done"), target("On error", "onError", "end as failed")),
    ];
  }

  function parseForm() {
    const sources = stepOptions((id, st) => st.type === "prompt" || st.type === "tool");
    const chosen = new Set(fromList(step));
    const fromBox = el(
      "fieldset",
      { class: "wf-checks" },
      el("legend", { class: "wf-field-label" }, "Reads the reply of"),
      ...(sources.length ? sources : [])
        .map((o) => {
          const box = el("input", { type: "checkbox", value: o.value, checked: chosen.has(o.value) });
          box.addEventListener("change", () => {
            if (box.checked) chosen.add(o.value);
            else chosen.delete(o.value);
            setFrom(step, [...chosen]);
            s.onChange(true);
          });
          return el("label", { class: "wf-check" }, box, el("span", {}, o.label), el("span", { class: "wf-faint" }, def.steps[o.value].type));
        }),
      !sources.length ? el("p", { class: "wf-field-hint" }, "Add a prompt or tool step first.") : null,
      el("p", { class: "wf-field-hint" }, "With several, the one that finished most recently is parsed.")
    );
    for (const id of chosen) if (!def.steps[id]) fromBox.append(el("p", { class: "wf-field-hint is-err" }, `"${id}" names no step.`));

    const fields = step.fields && typeof step.fields === "object" ? step.fields : (step.fields = {});
    const results = el("ul", { class: "wf-test-results", "aria-live": "polite" });
    const sample = el("textarea", { class: "input wf-mono wf-sample", rows: "4", placeholder: "Paste a reply to test the patterns against", spellcheck: "false" });
    sample.value = s.samples.get(s.selected) ?? "";
    const runTest = () => {
      s.samples.set(s.selected, sample.value);
      if (!sample.value.trim()) return void results.replaceChildren(el("li", { class: "wf-faint" }, "Nothing to test yet."));
      results.replaceChildren(
        ...testParse(fields, sample.value).map((r) =>
          el("li", { class: `wf-test ${r.ok ? "is-ok" : r.error ? "is-err" : "is-miss"}` }, el("span", { class: "wf-mono wf-test-name" }, r.name), el("span", { class: "wf-mono wf-test-value" }, r.ok ? r.value || "(empty)" : r.error ? "does not compile" : "no match"))
        )
      );
    };
    sample.addEventListener("input", runTest);

    const required = () => (Array.isArray(step.required) ? new Set(step.required) : new Set(Object.keys(fields)));
    const rows = el("div", { class: "wf-rows" });
    const drawFields = () => {
      const req = required();
      rows.replaceChildren(
        ...Object.keys(fields).map((name) => {
          const n = el("input", { class: "input wf-mono", type: "text", "aria-label": "Field name", spellcheck: "false" });
          n.value = name;
          const err = el("p", { class: "wf-field-hint is-err", hidden: true });
          n.addEventListener("change", () => {
            const nn = n.value.trim();
            if (nn === name) return;
            if (!FIELD_NAME.test(nn) || nn in fields || nn === "matched" || nn === "text" || nn === "source") {
              err.hidden = false;
              err.textContent = !FIELD_NAME.test(nn) ? "A name is letters, digits and underscores." : `"${nn}" is taken.`;
              n.value = name;
              return;
            }
            const entries = Object.entries(fields).map(([a, b]) => [a === name ? nn : a, b]);
            for (const a of Object.keys(fields)) delete fields[a];
            Object.assign(fields, Object.fromEntries(entries));
            if (Array.isArray(step.required)) step.required = step.required.map((r) => (r === name ? nn : r));
            s.onChange(true);
          });
          const re = el("input", { class: "input wf-mono", type: "text", "aria-label": `Pattern for ${name}`, placeholder: "RESULT: (\\w+)", spellcheck: "false" });
          re.value = fields[name] ?? "";
          const reErr = el("p", { class: "wf-field-hint is-err", hidden: true });
          const compile = () => {
            try {
              new RegExp(re.value, "m");
              reErr.hidden = true;
            } catch (e) {
              reErr.hidden = false;
              reErr.textContent = e.message;
            }
          };
          compile();
          re.addEventListener("input", () => {
            fields[name] = re.value;
            compile();
            runTest();
            s.onChange(false);
          });
          const req_ = el("input", { type: "checkbox", checked: req.has(name), "aria-label": `${name} is required`, title: "Required: a miss counts as no match" });
          req_.addEventListener("change", () => {
            const r = required();
            if (req_.checked) r.add(name);
            else r.delete(name);
            const all = Object.keys(fields).every((f) => r.has(f));
            if (all) delete step.required;
            else step.required = Object.keys(fields).filter((f) => r.has(f));
            s.onChange(false);
          });
          const rm = el("button", { type: "button", class: "wf-icon-btn", "aria-label": `Remove field ${name}`, title: "Remove", onClick: () => {
            delete fields[name];
            if (Array.isArray(step.required)) step.required = step.required.filter((r) => r !== name);
            s.onChange(true);
          } }, svgIcon("x", { size: 12 }));
          return el("div", { class: "wf-field-row" }, el("div", { class: "wf-row is-parse" }, n, re, el("label", { class: "wf-req" }, req_, el("span", {}, "req")), rm), err, reErr);
        })
      );
    };
    drawFields();
    const add = el("button", { type: "button", class: "btn is-quiet wf-btn wf-add" }, svgIcon("plus", { size: 12 }), "Add field");
    add.addEventListener("click", () => {
      let n = 1;
      while (`field${n}` in fields) n++;
      fields[`field${n}`] = "";
      if (Array.isArray(step.required)) step.required.push(`field${n}`);
      s.onChange(true);
    });
    runTest();
    const fromPrompt = [...chosen].some((id) => def.steps[id]?.type === "prompt");
    return [
      section("Source", fromBox),
      section("Fields", el("p", { class: "wf-field-hint" }, "JavaScript patterns, multi-line mode. The value is the first capture group, else the whole match."), rows, add),
      section("Test", sample, results),
      fromPrompt ? section("On a miss", template("Follow-up", () => step.followUp, (v) => (v ? (step.followUp = v) : delete step.followUp), { rows: 3, placeholder: "Sent once to the source conversation; its reply is parsed again.", hint: "Only for a prompt source. Empty: no follow-up." })) : null,
      section("Then", target("Next", "next", "end as done"), target("On no match", "onNoMatch", "end as needs-you")),
    ];
  }

  function branchForm() {
    const cases = step.cases && typeof step.cases === "object" ? step.cases : (step.cases = {});
    const rows = el("div", { class: "wf-rows" });
    const targets = [{ value: "", label: "choose a step" }, ...stepOptions()];
    const draw = () => {
      rows.replaceChildren(
        ...Object.keys(cases).map((value) => {
          const v = el("input", { class: "input wf-mono", type: "text", "aria-label": "Case value", spellcheck: "false" });
          v.value = value;
          v.addEventListener("change", () => {
            const nv = v.value;
            if (nv === value || nv in cases) return void (v.value = value);
            const entries = Object.entries(cases).map(([a, b]) => [a === value ? nv : a, b]);
            for (const a of Object.keys(cases)) delete cases[a];
            Object.assign(cases, Object.fromEntries(entries));
            s.onChange(false);
            draw();
          });
          const t = el("select", { class: "input", "aria-label": `Step for ${value}` }, ...targets.map((o) => el("option", { value: o.value }, o.label)));
          t.value = cases[value] ?? "";
          t.addEventListener("change", () => {
            cases[value] = t.value;
            s.onChange(false);
          });
          const rm = el("button", { type: "button", class: "wf-icon-btn", "aria-label": `Remove case ${value}`, title: "Remove", onClick: () => { delete cases[value]; s.onChange(false); draw(); } }, svgIcon("x", { size: 12 }));
          return el("div", { class: "wf-row" }, v, el("span", { class: "wf-arrow", "aria-hidden": "true" }, svgIcon("chevron", { size: 12 })), t, rm);
        })
      );
    };
    draw();
    const add = el("button", { type: "button", class: "btn is-quiet wf-btn wf-add" }, svgIcon("plus", { size: 12 }), "Add case");
    add.addEventListener("click", () => {
      let n = 1;
      while (`VALUE${n}` in cases) n++;
      cases[`VALUE${n}`] = "";
      s.onChange(false);
      draw();
      rows.lastElementChild?.querySelector("input")?.select();
    });
    return [
      section("Branch on", template("Value", () => step.on, (v) => (step.on = v), { single: true, placeholder: "{{parse.status}}", hint: "Compared, as text, with each case." })),
      section("Cases", rows, add),
      section("Otherwise", target("Default", "default", "end as needs-you")),
    ];
  }

  function loopForm() {
    return [
      section(
        "Loop",
        select("Back to", [{ value: "", label: "choose a step" }, ...stepOptions()], () => step.target ?? "", (v) => (v ? (step.target = v) : delete step.target)),
        number("At most", () => step.max, (v) => (v === undefined ? delete step.max : (step.max = Math.floor(v))), { min: 1, hint: "Times the loop jumps back before it takes Exhausted." })
      ),
      section("Then", target("Exhausted", "exhausted", "end as needs-you")),
    ];
  }

  function approvalForm() {
    return [
      section("Ask", template("Message", () => step.message, (v) => (step.message = v), { rows: 4, placeholder: "What the person is signing off on." })),
      section("Then", target("Next (approved)", "next", "end as done"), target("On reject", "onReject", "end as cancelled")),
    ];
  }

  function endForm() {
    const key = step.type === "done" ? "summary" : "reason";
    return [section(step.type === "done" ? "Run succeeded" : "Hand to a person", template(step.type === "done" ? "Summary" : "Reason", () => step[key], (v) => (step[key] = v), { rows: 4, placeholder: step.type === "done" ? "What the run achieved." : "Why a person is needed." }))];
  }

  /* --- the step's head ------------------------------------------------------------------------ */

  function stepHead() {
    const meta = TYPES[step.type] ?? { label: step.type, tone: "dim" };
    const idInput = el("input", { class: "input wf-mono", type: "text", spellcheck: "false", maxlength: "32" });
    idInput.value = s.selected;
    const idErr = el("p", { class: "wf-field-hint is-err", hidden: true });
    idInput.addEventListener("change", () => {
      const err = s.rename(s.selected, idInput.value.trim());
      idErr.hidden = !err;
      idErr.textContent = err ?? "";
      if (err) idInput.value = s.selected;
    });
    const idField = labelled("Id", idInput, "Used in templates as {{id.field}}. Renaming updates every reference.");
    idField.append(idErr);
    const del = el("button", { type: "button", class: "btn is-warn wf-btn", onClick: () => s.remove(s.selected) }, svgIcon("trash", { size: 12 }), "Delete step");
    const start = def.start === s.selected ? el("span", { class: "wf-chip is-accent" }, svgIcon("flag", { size: 10 }), "start step") : el("button", { type: "button", class: "btn is-quiet wf-btn", onClick: () => s.setStart(s.selected) }, svgIcon("flag", { size: 12 }), "Make start");
    const mine = s.issues.list.filter((i) => i.step === s.selected);
    return [
      el(
        "div",
        { class: `wf-insp-head tone-${meta.tone}` },
        el("span", { class: "wf-node-icon" }, svgIcon(step.type, { size: 14 })),
        el("div", { class: "wf-insp-title" }, el("span", { class: "wf-insp-kind" }, meta.label), el("span", { class: "wf-insp-name" }, step.label || s.selected)),
        el("button", { type: "button", class: "wf-icon-btn", "aria-label": "Close the step, show the workflow", title: "Deselect (Escape)", onClick: () => s.select(null) }, svgIcon("x", { size: 13 }))
      ),
      issueList(mine),
      section(
        null,
        text("Label", () => step.label, (v) => (v ? (step.label = v) : delete step.label), { placeholder: s.selected, hint: "Shown on the canvas; the id when empty." }),
        idField,
        el("div", { class: "wf-insp-actions" }, start, del)
      ),
    ];
  }

  /* --- nothing selected: the workflow ------------------------------------------------------- */

  function workflowForm() {
    const input = def.input ?? (def.input = { kind: "lines" });
    const projects = s.catalog?.projects ?? [];
    const general = s.issues.list.filter((i) => !i.step);
    const n = Object.keys(def.steps).length;
    return [
      el("div", { class: "wf-insp-head tone-accent" }, el("span", { class: "wf-node-icon" }, svgIcon("workflow", { size: 14 })), el("div", { class: "wf-insp-title" }, el("span", { class: "wf-insp-kind" }, "Workflow"), el("span", { class: "wf-insp-name" }, def.name || def.id))),
      issueList(general),
      section(
        null,
        text("Name", () => def.name, (v) => (def.name = v), { maxlength: "80" }),
        (() => {
          const area = el("textarea", { class: "input", rows: "2", placeholder: "One line on what it does" });
          area.value = def.description ?? "";
          area.addEventListener("input", () => {
            def.description = area.value;
            s.onChange(false);
          });
          return labelled("Description", area);
        })(),
        select("Project", [{ value: "", label: "none" }, ...projects.map((p) => ({ value: p.id, label: p.name || p.id }))], () => def.project ?? "", (v) => (v ? (def.project = v) : delete def.project), { hint: "Every conversation a run opens joins this project." }),
        number("Cost cap, US dollars", () => def.costCapUsd, (v) => (v === undefined ? delete def.costCapUsd : (def.costCapUsd = v)), { placeholder: "package default", hint: "A run that reaches it is stopped and handed to you." })
      ),
      section(
        "Input",
        select(
          "Kind",
          [
            { value: "lines", label: "Lines: one run per non-empty line" },
            { value: "text", label: "Text: the whole text is one run" },
          ],
          () => input.kind ?? "lines",
          (v) => (input.kind = v)
        ),
        text("Label", () => input.label, (v) => (v ? (input.label = v) : delete input.label), { placeholder: "Notion bug links" }),
        text("Placeholder", () => input.placeholder, (v) => (v ? (input.placeholder = v) : delete input.placeholder), { placeholder: "One link per line" }),
        el("p", { class: "wf-field-hint" }, "Templates read it as {{input}}.")
      ),
      section(
        "Graph",
        select("Start step", [{ value: "", label: "choose a step" }, ...Object.keys(def.steps).map((id) => ({ value: id, label: stepName(id) }))], () => def.start ?? "", (v) => (def.start = v)),
        el("p", { class: "wf-field-hint" }, `${n} step${n === 1 ? "" : "s"}. Select one on the canvas to edit it.`)
      ),
    ];
  }

  let body;
  if (!step) body = workflowForm();
  else {
    const forms = { prompt: promptForm, tool: toolForm, parse: parseForm, branch: branchForm, loop: loopForm, approval: approvalForm, done: endForm, needs: endForm };
    body = [...stepHead(), ...(forms[step.type]?.() ?? [el("p", { class: "wf-error" }, `Unknown step type "${step.type}".`)])];
    if (isEnd(step.type) && FLOW_FIELDS[step.type].length === 0) body.push(el("p", { class: "wf-field-hint wf-insp-foot" }, "An end step has no way out: the run finishes here."));
  }
  const hasTemplates = body.some((n) => n && n.querySelector?.("[data-template]"));
  return el("div", { class: "wf-insp-body" }, el("div", { class: "wf-insp-scroll" }, ...body.filter(Boolean)), hasTemplates ? tray.node : null);
}
