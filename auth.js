// Signing in, device-code style (like `gh auth login`): ask Scareathon for a
// code, have the user approve it on the site while signed in there, and
// poll until Scareathon hands over an arcade token. The user never sees or
// pastes the token; it goes straight into the credentials file.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAuth({ api, store, envToken, now = () => Date.now(), wait = sleep }) {
  // The sign-in waiting for the user, if any
  let pending = null;
  let poller = null;

  const saved = () => store.get(api.apiUrl);

  function currentToken() {
    return envToken || saved()?.token || null;
  }

  function forget() {
    if (!envToken) store.clear(api.apiUrl);
  }

  // One poll. Returns the pending login's new state. The background poller
  // and a waiting sign_in call share whichever poll is in flight, so they
  // can't both collect the same approval.
  let inFlight = null;
  function pollOnce() {
    inFlight ??= doPoll().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function doPoll() {
    if (!pending) {
      const credentials = saved();
      return credentials ? { state: "signed_in", username: credentials.username } : { state: "none" };
    }
    if (now() > pending.expiresAt) {
      pending = null;
      return { state: "expired" };
    }
    const result = await api.pollDeviceLogin(pending.deviceCode);
    if (result.status === "approved") {
      store.save(api.apiUrl, { token: result.token, username: result.username });
      pending = null;
      return { state: "signed_in", username: result.username };
    }
    if (result.status === "pending") return { state: "pending" };
    pending = null;
    return { state: result.status === "denied" ? "denied" : "expired" };
  }

  // Keeps polling in the background, so the sign-in finishes even if the AI
  // doesn't call anything until the user says they've approved it
  function startPolling() {
    if (poller) return;
    poller = (async () => {
      while (pending) {
        await wait(pending.interval * 1000);
        try {
          await pollOnce();
        } catch {
          // Network blip: try again next round
        }
      }
      poller = null;
    })();
  }

  return {
    currentToken,
    forget,
    get usingEnvToken() {
      return Boolean(envToken);
    },
    savedUsername: () => saved()?.username ?? null,
    hasPending: () => Boolean(pending),

    // Starts a sign-in, or returns the one already waiting
    async begin(clientName) {
      if (pending && now() <= pending.expiresAt) return pending;
      const started = await api.startDeviceLogin(clientName);
      pending = {
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        verificationUrlComplete: started.verificationUrlComplete,
        interval: Math.max(1, started.interval ?? 3),
        expiresAt: now() + started.expiresIn * 1000,
      };
      startPolling();
      return pending;
    },

    // Polls until the user answers or waitSeconds runs out
    async waitForAnswer(waitSeconds) {
      const deadline = now() + waitSeconds * 1000;
      let result = await pollOnce();
      while (result.state === "pending" && now() < deadline) {
        await wait(Math.min((pending?.interval ?? 3) * 1000, Math.max(0, deadline - now())));
        result = await pollOnce();
      }
      return result;
    },

    pending: () => pending,
  };
}
