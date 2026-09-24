import assert from "node:assert/strict";
import * as notion from "./client.js";
import * as tools from "./tools.js";

// --- normalizeId --------------------------------------------------------
assert.equal(
  notion.normalizeId("https://www.notion.so/My-Page-1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c", "page_id"),
  "1f2e3d4c-5b6a-7f8e-9d0c-1b2a3f4e5d6c"
);
assert.equal(
  notion.normalizeId("1f2e3d4c5b6a7f8e9d0c1b2a3f4e5d6c", "page_id"),
  "1f2e3d4c-5b6a-7f8e-9d0c-1b2a3f4e5d6c"
);
assert.equal(
  notion.normalizeId("https://app.notion.com/p/team/Server-2-0-34f0d0be14cb800486d9ca4e01cb65b0?p=3c30d0be14cb81a69079c5ab8faab4b6&pm=s", "page_id"),
  "3c30d0be-14cb-81a6-9079-c5ab8faab4b6",
  "a peeked page is the ?p= id, not the database in the path"
);
assert.throws(() => notion.normalizeId("not-an-id", "page_id"));
console.log("normalizeId: ok");

// --- coerceProperties ----------------------------------------------------
const schema = new Map([
  ["Status", "status"],
  ["Tags", "multi_select"],
  ["Score", "number"],
  ["Name", "title"],
]);
const coerced = notion.coerceProperties({ Status: "Done", Tags: ["a", "b"], Score: "3.5" }, schema);
assert.deepEqual(coerced.Status, { status: { name: "Done" } });
assert.deepEqual(coerced.Tags, { multi_select: [{ name: "a" }, { name: "b" }] });
assert.deepEqual(coerced.Score, { number: 3.5 });
assert.throws(() => notion.coerceProperties({ Nope: "x" }, schema), /no propert/);
console.log("coerceProperties: ok");

// --- describeProperty / titleOf ------------------------------------------
const page = {
  properties: {
    Name: { type: "title", title: [{ plain_text: "Hello" }] },
    Done: { type: "checkbox", checkbox: true },
  },
};
assert.equal(notion.titleOf(page), "Hello");
assert.equal(notion.describeProperties(page, "  ").includes("Done (checkbox): true"), true);
console.log("describeProperty/titleOf: ok");

// --- createClient requires token ------------------------------------------
assert.throws(() => notion.createClient({}), /no Notion token configured/);
assert.throws(() => notion.createClient({}), (e) => !String(e.message).includes("Bearer"));
console.log("createClient token guard: ok");

// --- mocked fetch: search formats and paginates ---------------------------
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const body = JSON.parse(init.body);
  assert.equal(init.headers["Notion-Version"], "2026-03-11");
  assert.equal(init.headers.Authorization, "Bearer secret-token-abc");
  if (!body.start_cursor) {
    return {
      status: 200,
      text: async () =>
        JSON.stringify({
          results: [{ object: "page", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", properties: { Name: { type: "title", title: [{ plain_text: "First" }] } } }],
          has_more: true,
          next_cursor: "cursor-2",
        }),
    };
  }
  return {
    status: 200,
    text: async () =>
      JSON.stringify({
        results: [{ object: "page", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", properties: { Name: { type: "title", title: [{ plain_text: "Second" }] } } }],
        has_more: false,
      }),
  };
};

const out = await tools.search({ query: "Foo", limit: 2 }, { config: { token: "secret-token-abc" } });
assert.ok(out.includes("First"));
assert.ok(out.includes("Second"));
assert.ok(!out.includes("secret-token-abc"), "token must never appear in tool output");
assert.equal(calls.length, 2, "expected pagination to make two requests");
console.log("search + pagination: ok");

// --- error path never includes token --------------------------------------
globalThis.fetch = async () => ({
  status: 404,
  text: async () => JSON.stringify({ code: "object_not_found", message: "Could not find page" }),
});
try {
  await tools.pageGet({ page_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, { config: { token: "another-secret" } });
  assert.fail("expected throw");
} catch (e) {
  assert.ok(!String(e.message).includes("another-secret"));
  assert.ok(e.message.includes("not shared with this connection"));
}
console.log("error path token safety: ok");

globalThis.fetch = realFetch;
console.log("ALL OK");
