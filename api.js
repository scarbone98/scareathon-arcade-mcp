// HTTP client for the Scareathon arcade API.

export const SITE_URL = "https://www.scareathon.rip";
export const DEFAULT_API_URL = "https://scareathon-v3-production.up.railway.app";

export class ScareathonApiError extends Error {
  constructor(message, { status, errors, checks, notSignedIn = false } = {}) {
    super(message);
    this.status = status;
    this.errors = errors;
    this.checks = checks;
    this.notSignedIn = notSignedIn;
  }
}

const NOT_SIGNED_IN =
  "You're not signed in to Scareathon yet. Call the sign_in tool, then show the user the link and code it returns.";

// getToken: returns the current arcade token, or null when signed out.
// onUnauthorized: called when the API rejects the token (revoked or expired).
export function createApi({ baseUrl = DEFAULT_API_URL, getToken = () => null, onUnauthorized = () => {}, fetchImpl = fetch }) {
  const apiUrl = baseUrl.replace(/\/$/, "");

  async function request(path, { method = "GET", body, auth = true } = {}) {
    const token = auth ? getToken() : null;
    if (auth && !token) throw new ScareathonApiError(NOT_SIGNED_IN, { notSignedIn: true });

    const headers = { Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response;
    try {
      response = await fetchImpl(`${apiUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new ScareathonApiError(`Couldn't reach the Scareathon API at ${apiUrl}: ${error.message}`);
    }

    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && token) {
      onUnauthorized();
      throw new ScareathonApiError(
        `Scareathon didn't accept the saved sign-in (it may have been disconnected on ${SITE_URL}/arcade/create). ${NOT_SIGNED_IN}`,
        { status: 401, notSignedIn: true }
      );
    }
    if (!response.ok) {
      const message = (payload.error || `HTTP ${response.status}`).replace(/\.$/, "");
      throw new ScareathonApiError(`${message}.`, {
        status: response.status,
        errors: payload.errors,
        checks: payload.checks,
      });
    }
    return payload.data ?? payload;
  }

  return {
    apiUrl,
    getSpec: () => request("/arcade/spec", { auth: false }),
    startDeviceLogin: (clientName) => request("/arcade/device/start", { method: "POST", body: { clientName }, auth: false }),
    pollDeviceLogin: (deviceCode) => request("/arcade/device/poll", { method: "POST", body: { deviceCode }, auth: false }),
    me: () => request("/arcade/me"),
    revokeCurrentToken: () => request("/arcade/tokens/current", { method: "DELETE" }),
    validate: (manifest) => request("/arcade/games/validate", { method: "POST", body: { manifest } }),
    submit: (manifest) => request("/arcade/games", { method: "POST", body: { manifest } }),
    listMine: () => request("/arcade/games/mine"),
    getGame: (slug) => request(`/arcade/games/${encodeURIComponent(slug)}`),

    // Everything the model needs to fix a failed call, as text
    describeError(error) {
      if (!(error instanceof ScareathonApiError)) return `Unexpected error: ${error?.message ?? error}`;
      const lines = [error.message];
      if (error.errors?.length) lines.push("Manifest problems:", ...error.errors.map((entry) => `- ${entry}`));
      if (error.checks?.length) {
        lines.push("URL checks:");
        for (const check of error.checks) {
          const mark = check.ok ? "ok" : check.level === "error" ? "FAIL" : "warn";
          lines.push(`- [${mark}] ${check.label}${check.detail ? `: ${check.detail}` : ""}`);
        }
      }
      return lines.join("\n");
    },
  };
}
