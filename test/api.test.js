import { test } from "node:test";
import assert from "node:assert/strict";
import { createApi, DEFAULT_API_URL, ScareathonApiError } from "../api.js";

function fakeFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body = {} } = respond(url, init);
    return { ok: status < 400, status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test("talks to the real Scareathon API unless told otherwise", () => {
  assert.equal(createApi({}).apiUrl, DEFAULT_API_URL);
  assert.equal(createApi({ baseUrl: "http://localhost:3000/" }).apiUrl, "http://localhost:3000");
});

test("sends the saved token and unwraps data", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 201, body: { data: { slug: "bat-dash" } } }));
  const api = createApi({ baseUrl: "https://api.example", getToken: () => "sca_abc", fetchImpl });
  assert.deepEqual(await api.submit({ name: "Bat Dash" }), { slug: "bat-dash" });
  assert.equal(calls[0].url, "https://api.example/arcade/games");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sca_abc");
  assert.deepEqual(JSON.parse(calls[0].init.body), { manifest: { name: "Bat Dash" } });
});

test("the spec and signing in need no token", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ body: { data: { ok: 1 } } }));
  const api = createApi({ baseUrl: "https://api.example", fetchImpl });
  await api.getSpec();
  await api.startDeviceLogin("Claude Code");
  await api.pollDeviceLogin("dev");
  assert.ok(calls.every((call) => call.init.headers.Authorization === undefined));
});

test("asks the AI to sign in, without calling the API, when signed out", async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({}));
  const error = await createApi({ fetchImpl }).listMine().catch((caught) => caught);
  assert.ok(error.notSignedIn);
  assert.match(error.message, /sign_in/);
  assert.equal(calls.length, 0);
});

test("forgets a token the API rejects", async () => {
  let forgotten = false;
  const { fetchImpl } = fakeFetch(() => ({ status: 401, body: { error: "Unauthorized" } }));
  const api = createApi({ getToken: () => "sca_old", onUnauthorized: () => { forgotten = true; }, fetchImpl });
  const error = await api.listMine().catch((caught) => caught);
  assert.ok(forgotten);
  assert.ok(error.notSignedIn);
});

test("turns API errors into text the model can act on", async () => {
  const { fetchImpl } = fakeFetch(() => ({
    status: 422,
    body: {
      error: "The game URL didn't pass the automated checks",
      checks: [
        { label: "Page loads", ok: true, level: "error" },
        { label: "Allows the arcade to show it in an iframe", ok: false, level: "error", detail: "Remove X-Frame-Options" },
      ],
    },
  }));
  const api = createApi({ getToken: () => "sca_x", fetchImpl });
  const error = await api.submit({}).catch((caught) => caught);
  assert.ok(error instanceof ScareathonApiError);
  const text = api.describeError(error);
  assert.match(text, /\[FAIL\] Allows the arcade to show it in an iframe: Remove X-Frame-Options/);
  assert.match(text, /\[ok\] Page loads/);
});
