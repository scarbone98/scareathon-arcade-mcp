import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth } from "../auth.js";
import { createCredentialStore, defaultCredentialsPath } from "../credentials.js";

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scareathon-mcp-"));
  return createCredentialStore(path.join(dir, "nested", "credentials.json"));
}

function fakeApi(pollAnswers) {
  const polls = [];
  return {
    polls,
    apiUrl: "https://api.example",
    startDeviceLogin: async () => ({
      deviceCode: "secret-device-code",
      userCode: "BCDF-2345",
      verificationUrl: "https://www.scareathon.rip/arcade/connect",
      verificationUrlComplete: "https://www.scareathon.rip/arcade/connect?code=BCDF-2345",
      expiresIn: 600,
      interval: 3,
    }),
    pollDeviceLogin: async (deviceCode) => {
      polls.push(deviceCode);
      return pollAnswers.shift() ?? { status: "pending" };
    },
  };
}

// Never lets the background poller run on its own, so tests drive every poll
const neverWait = () => new Promise(() => {});

test("credentials are private to the user and kept per API", () => {
  const store = tempStore();
  store.save("https://api.example", { token: "sca_1", username: "bob" });
  store.save("http://localhost:3000", { token: "sca_2", username: "dev" });
  assert.equal(store.get("https://api.example").token, "sca_1");
  assert.equal(store.get("http://localhost:3000").username, "dev");
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(store.path).mode & 0o777, 0o600);
  }
  store.clear("https://api.example");
  assert.equal(store.get("https://api.example"), null);
  assert.equal(store.get("http://localhost:3000").token, "sca_2");
});

test("credentials live in the user's config folder", () => {
  assert.equal(
    defaultCredentialsPath({ XDG_CONFIG_HOME: "/home/me/.config" }, "linux"),
    path.join("/home/me/.config", "scareathon-arcade-mcp", "credentials.json")
  );
  assert.equal(
    defaultCredentialsPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"),
    path.join("C:\\Users\\me\\AppData\\Roaming", "scareathon-arcade-mcp", "credentials.json")
  );
});

test("device sign-in saves the token once the user approves", async () => {
  const store = tempStore();
  const api = fakeApi([{ status: "pending" }, { status: "approved", token: "sca_new", username: "bob" }]);
  const auth = createAuth({ api, store, wait: neverWait });

  assert.equal(auth.currentToken(), null);
  const login = await auth.begin("claude-code");
  assert.equal(login.userCode, "BCDF-2345");
  // Asking again reuses the waiting sign-in instead of making a new code
  assert.equal(await auth.begin("claude-code"), login);

  assert.deepEqual(await auth.waitForAnswer(0), { state: "pending" });
  const clock = Date.now();
  const result = await createAuth({ api, store, wait: neverWait }).waitForAnswer(0);
  assert.deepEqual(result, { state: "none" }, "a different process has no sign-in waiting");
  assert.ok(Date.now() - clock < 1000);

  assert.deepEqual(await auth.waitForAnswer(0), { state: "signed_in", username: "bob" });
  assert.equal(auth.currentToken(), "sca_new");
  assert.equal(store.get("https://api.example").token, "sca_new");
  assert.deepEqual(api.polls, ["secret-device-code", "secret-device-code"]);
});

test("a declined sign-in saves nothing", async () => {
  const store = tempStore();
  const auth = createAuth({ api: fakeApi([{ status: "denied" }]), store, wait: neverWait });
  await auth.begin("cursor");
  assert.deepEqual(await auth.waitForAnswer(0), { state: "denied" });
  assert.equal(auth.currentToken(), null);
  assert.equal(auth.hasPending(), false);
});

test("an expired sign-in is dropped without polling", async () => {
  let time = 0;
  const api = fakeApi([]);
  const auth = createAuth({ api, store: tempStore(), wait: neverWait, now: () => time });
  await auth.begin("cursor");
  time = 601_000;
  assert.deepEqual(await auth.waitForAnswer(0), { state: "expired" });
  assert.equal(api.polls.length, 0);
});

test("SCAREATHON_TOKEN overrides the saved sign-in and is never cleared", () => {
  const store = tempStore();
  store.save("https://api.example", { token: "sca_saved", username: "bob" });
  const auth = createAuth({ api: fakeApi([]), store, envToken: "sca_env", wait: neverWait });
  assert.equal(auth.currentToken(), "sca_env");
  auth.forget();
  assert.equal(store.get("https://api.example").token, "sca_saved");
});
