// Where the arcade token lives after signing in: a small JSON file only the
// user can read, keyed by API URL so a local test server and the real site
// don't overwrite each other.
//   Linux/macOS: $XDG_CONFIG_HOME or ~/.config, then scareathon-arcade-mcp/credentials.json
//   Windows:     %APPDATA%\scareathon-arcade-mcp\credentials.json
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function defaultCredentialsPath(env = process.env, platform = process.platform) {
  const base =
    platform === "win32"
      ? env.APPDATA || path.join(os.homedir(), "AppData", "Roaming")
      : env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "scareathon-arcade-mcp", "credentials.json");
}

export function createCredentialStore(filePath) {
  const readAll = () => {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      return {};
    }
  };

  const writeAll = (all) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    // Write then rename, so a crash can't leave half a file
    const temp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, filePath);
  };

  return {
    path: filePath,
    get(apiUrl) {
      return readAll()[apiUrl] ?? null;
    },
    save(apiUrl, credentials) {
      writeAll({ ...readAll(), [apiUrl]: { ...credentials, savedAt: new Date().toISOString() } });
    },
    clear(apiUrl) {
      const all = readAll();
      if (!(apiUrl in all)) return;
      delete all[apiUrl];
      writeAll(all);
    },
  };
}
