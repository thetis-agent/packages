// What an artboard says about itself: the props block, the runtime's injection, the network it would reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { declaredProps, externalRefs, injectRuntime, runtimeSource } from "../lib/props.js";

const block = (json) => `<!doctype html><html><head><script type="application/json" id="canvas-props">${json}</script></head><body></body></html>`;

test("declaredProps: a good block, a missing one, a malformed one, bad editors and names, select without options", () => {
  const good = declaredProps(block('{"accent":{"editor":"color","default":"#123","label":"Accent"},"n":{"editor":"number","default":"3","min":1,"max":9},"pick":{"editor":"select","default":"z","options":["a","b"]},"on":{"editor":"toggle","default":1},"t":{"editor":"text"}}'));
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.decl, {
    accent: { editor: "color", default: "#123", label: "Accent" },
    n: { editor: "number", default: 3, min: 1, max: 9 },
    pick: { editor: "select", default: "a", options: ["a", "b"] },
    on: { editor: "toggle", default: true },
    t: { editor: "text", default: "" },
  });
  assert.deepEqual(declaredProps("<html></html>"), { decl: null, problems: [] });
  const bad = declaredProps(block("{ nope"));
  assert.equal(bad.decl, null);
  assert.match(bad.problems[0], /not JSON/);
  const mixed = declaredProps(block('{"Bad":{"editor":"color"},"x":{"editor":"slider"},"y":"str","s":{"editor":"select"},"ok":{"editor":"text","default":"v"}}'));
  assert.deepEqual(Object.keys(mixed.decl), ["ok"]);
  assert.equal(mixed.problems.length, 4);
  assert.match(mixed.problems[1], /editor "slider"/);
  assert.match(mixed.problems[3], /select prop s needs options/);
  assert.match(declaredProps(block("[1]")).problems[0], /must be an object/);
});

test("injectRuntime puts the runtime after <head>, else after <html>, else first; the runtime is a plain script", () => {
  const tag = "<script data-canvas-runtime>";
  const withHead = injectRuntime("<!doctype html><html><head><title>x</title></head></html>", "R");
  assert.equal(withHead, `<!doctype html><html><head>${tag}R</script><title>x</title></head></html>`);
  assert.equal(injectRuntime("<html lang='en'><body>x</body></html>", "R"), `<html lang='en'>${tag}R</script><body>x</body></html>`);
  assert.equal(injectRuntime("<p>x</p>", "R"), `${tag}R</script><p>x</p>`);
  const source = runtimeSource();
  assert.ok(source.length > 500);
  assert.doesNotMatch(source, /^\s*import\s|\bexport\s/m, "a plain script, no module syntax");
  assert.doesNotThrow(() => new Function(source), "it parses");
  assert.match(injectRuntime("<html><head></head></html>"), /data-canvas-runtime>[\s\S]*canvas-props/);
});

test("externalRefs names the hosts a document reaches, minus the fonts the frame allows", () => {
  const html = `<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet"><img src="https://cdn.example.com/a.png"><img src='http://Other.Example.org/b.png'><img src="assets/c.png"><style>@font-face{src:url(https://fonts.gstatic.com/x.woff2)} .x{background:url("https://images.example.com/y.jpg")} @import "https://css.example.com/z.css";</style>`;
  assert.deepEqual(externalRefs(html), ["cdn.example.com", "css.example.com", "images.example.com", "other.example.org"]);
  assert.deepEqual(externalRefs("<img src='assets/x.png'>"), []);
});
