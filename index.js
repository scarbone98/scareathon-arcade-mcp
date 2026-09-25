#!/usr/bin/env node
// Scareathon Arcade MCP server: lets an AI read the arcade's game spec and
// check and submit games to https://www.scareathon.rip/arcade as you.
//
// It's a thin client for the Scareathon API. Everything real (the spec,
// validation, URL checks, drafts, review) happens on the Scareathon server,
// so this package rarely needs updating when the spec changes.
//
// No config needed: the AI calls sign_in, you approve the link on the site,
// and the token is saved to your user config folder (see credentials.js).
// Optional environment variables, for development and automation:
//   SCAREATHON_API_URL          another Scareathon API, e.g. http://localhost:3000
//   SCAREATHON_CREDENTIALS_FILE where to keep the sign-in instead
//   SCAREATHON_TOKEN            use this arcade token instead of signing in
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createApi, DEFAULT_API_URL, SITE_URL } from "./api.js";
import { createAuth } from "./auth.js";
import { createCredentialStore, defaultCredentialsPath } from "./credentials.js";

const store = createCredentialStore(process.env.SCAREATHON_CREDENTIALS_FILE || defaultCredentialsPath());
let auth;
const api = createApi({
  baseUrl: process.env.SCAREATHON_API_URL || DEFAULT_API_URL,
  getToken: () => auth.currentToken(),
  onUnauthorized: () => auth.forget(),
});
auth = createAuth({ api, store, envToken: process.env.SCAREATHON_TOKEN });

const manifestSchema = z
  .object({
    name: z.string().describe("3-40 chars. Fixed after the first submit; submit the same name again to update the game."),
    url: z.string().describe("https URL of the playable page. Must allow being framed and not redirect to another site."),
    tagline: z.string().describe("At most 60 chars, shown on the cartridge card."),
    color: z.string().describe('Cartridge label colour, "#rrggbb".'),
    aspectRatio: z.string().optional().describe('"W:H", default "16:9".'),
    mobile: z.boolean().optional().describe("true if fully playable by touch on a phone. Default false (hidden on phones)."),
    description: z.string().optional().describe("At most 500 chars."),
    controls: z.string().optional().describe("At most 200 chars."),
    coverImageUrl: z.string().optional().describe("https image for the cartridge label, ideally 16:9."),
    score: z
      .object({
        format: z.enum(["points", "time"]).optional().describe('"points" (default) or "time" (whole seconds).'),
        max: z.number().int().describe("Highest possible legit score; anything above is thrown away."),
      })
      .optional()
      .describe("Leave out if the game has no leaderboard."),
  })
  .passthrough();

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const failure = (error) => ({
  isError: true,
  content: [{ type: "text", text: api.describeError(error) }],
});

// Wraps a tool body so API failures come back to the model as readable errors
const tool = (run) => async (args) => {
  try {
    return await run(args ?? {});
  } catch (error) {
    return failure(error);
  }
};

function summarizeGame(game) {
  const live = game.versions.find((version) => version.id === game.liveVersionId);
  const lines = [
    `${game.name} (slug: ${game.slug}) by ${game.owner}`,
    live ? `Live on the shelf: v${live.version}` : "Not on the shelf yet",
    ...game.versions.map((version) => {
      const status = version.id === game.liveVersionId ? "live" : version.status;
      const auto = version.autoApproved ? ", no review needed" : "";
      const note = version.reviewNote ? ` Reviewer: "${version.reviewNote}"` : "";
      const stats = version.stats && version.status === "approved"
        ? ` (${version.stats.plays} plays, ${version.stats.players} players` +
          `${version.stats.signedInPlayers === undefined ? "" : ` [${version.stats.signedInPlayers} signed in, ${version.stats.networks} networks]`}` +
          `, ${version.stats.finishedRuns} finished runs` +
          `${version.stats.bestScore === null ? "" : `, best ${version.stats.bestScore}`})`
        : "";
      const warnings = version.checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail ?? "failed"}`);
      return `  v${version.version} [${status}${auto}] ${version.url}${stats}${note}${warnings.length ? `\n    warnings: ${warnings.join("; ")}` : ""}`;
    }),
  ];
  return lines.join("\n");
}

const server = new McpServer(
  { name: "scareathon-arcade", version: "1.0.0" },
  {
    instructions:
      "Tools for making games for the Scareathon arcade (https://www.scareathon.rip/arcade). " +
      "Always call get_arcade_spec first and follow it exactly. Build and host the game (e.g. GitHub Pages), " +
      "run validate_game until it passes, then submit_game. A new game is a draft until an admin approves it once; " +
      "after that, updates go live straight away. The author can play drafts at https://www.scareathon.rip/profile/developer. " +
      "Everything except get_arcade_spec needs the user signed in: call sign_in, show the user the link and code, " +
      "then call sign_in again with waitSeconds to finish. Never ask the user for a password or token.",
  }
);

function describeSignIn(login, intro) {
  return (
    `${intro}\n\n` +
    `Show the user this link and code:\n` +
    `  ${login.verificationUrlComplete}\n` +
    `  Code: ${login.userCode}\n\n` +
    `They open the link (signing in to Scareathon if asked), check the code matches, and click Approve. ` +
    `Then call sign_in with waitSeconds (e.g. 120) to finish. The link expires in ` +
    `${Math.max(1, Math.round((login.expiresAt - Date.now()) / 60000))} minutes.`
  );
}

server.registerTool(
  "sign_in",
  {
    title: "Sign in to Scareathon",
    description:
      "Connects this MCP server to the user's Scareathon account so it can submit games as them. The first call returns " +
      "a link and code for the user to approve on scareathon.rip; call again with waitSeconds to wait for their answer. " +
      "Never ask the user for a password or token.",
    inputSchema: {
      waitSeconds: z
        .number()
        .int()
        .min(0)
        .max(300)
        .optional()
        .describe("If a sign-in is waiting for the user, wait up to this long for them to approve it."),
    },
    annotations: { openWorldHint: true },
  },
  tool(async ({ waitSeconds = 0 }) => {
    if (auth.usingEnvToken) {
      const me = await api.me();
      return text(`Signed in as ${me.username} with the SCAREATHON_TOKEN environment variable.`);
    }
    if (!auth.hasPending() && auth.currentToken()) {
      // Check the saved sign-in still works (it may have been disconnected on the site)
      try {
        const me = await api.me();
        return text(`Already signed in as ${me.username}.`);
      } catch (error) {
        if (!error.notSignedIn) throw error;
      }
    }

    const clientName = server.server.getClientVersion()?.name || "An AI assistant";
    const hadPending = auth.hasPending();
    const login = await auth.begin(clientName);
    if (!hadPending && !waitSeconds) {
      return text(describeSignIn(login, "Started a sign-in to Scareathon."));
    }

    const result = await auth.waitForAnswer(waitSeconds);
    if (result.state === "signed_in") return text(`Signed in as ${result.username}. You can submit games now.`);
    if (result.state === "pending") return text(describeSignIn(login, "Still waiting for the user to approve the sign-in."));
    if (result.state === "denied") return text("The user declined the sign-in. Only try again if they ask you to.");
    return text("That sign-in expired. Call sign_in again for a new link.");
  })
);

server.registerTool(
  "sign_out",
  {
    title: "Sign out of Scareathon",
    description: "Disconnects this MCP server from the user's Scareathon account and forgets the saved sign-in.",
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  tool(async () => {
    if (auth.usingEnvToken) {
      return text("Signed in with the SCAREATHON_TOKEN environment variable; remove it from this server's config to sign out.");
    }
    if (!auth.currentToken()) return text("Not signed in.");
    try {
      await api.revokeCurrentToken();
    } catch (error) {
      if (!error.notSignedIn) throw error;
    }
    auth.forget();
    return text("Signed out. The connection is removed from the Scareathon account too.");
  })
);

server.registerTool(
  "whoami",
  {
    title: "Who am I signed in as",
    description: "The Scareathon account this MCP server submits games as, if any.",
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const me = await api.me();
    return text(`Signed in as ${me.username}.`);
  })
);

server.registerTool(
  "get_arcade_spec",
  {
    title: "Get the arcade game spec",
    description:
      "The rules a Scareathon arcade game must follow: hosting, iframe/sandbox rules, content rules, the score hookup " +
      "(a small script the game must include) and the manifest format. Read this before building or submitting a game.",
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const spec = await api.getSpec();
    return text(spec.markdown);
  })
);

server.registerTool(
  "validate_game",
  {
    title: "Check a game without submitting",
    description:
      "Dry run of submit_game: checks the manifest and runs the automated URL checks (loads, is HTML, can be framed), " +
      "and says whether submitting would create a new game or a new version. Nothing is saved.",
    inputSchema: { manifest: manifestSchema },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  tool(async ({ manifest }) => {
    const result = await api.validate(manifest);
    return text(result);
  })
);

server.registerTool(
  "submit_game",
  {
    title: "Submit a game",
    description:
      "Submits the game as the signed-in user. A new name creates a new game, saved as a draft until an admin approves " +
      "it (submitting again before then replaces the draft). The name of one of your approved games adds a new version " +
      "that goes live on the shelf straight away. Run validate_game first.",
    inputSchema: { manifest: manifestSchema },
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  tool(async ({ manifest }) => {
    const game = await api.submit(manifest);
    const version = game.versions[0];
    const outcome =
      version.status === "approved"
        ? `${game.name} v${version.version} is live on the arcade shelf: ${SITE_URL}/arcade?game=${encodeURIComponent(game.name)}`
        : `Submitted ${game.name} v${version.version} as a draft; an admin reviews it before it goes on the shelf.\n` +
          `The author can play it and follow the review at ${SITE_URL}/profile/developer.`;
    return text(`${outcome}\n\n${summarizeGame(game)}`);
  })
);

server.registerTool(
  "list_my_games",
  {
    title: "List my arcade games",
    description:
      "Your submitted games with every version's status (draft, live, approved, rejected, replaced), reviewer notes, " +
      "and play stats for approved versions.",
    annotations: { readOnlyHint: true },
  },
  tool(async () => {
    const games = await api.listMine();
    return text(games.length ? games.map(summarizeGame).join("\n\n") : "You haven't submitted any games yet.");
  })
);

server.registerTool(
  "get_game_status",
  {
    title: "Get one game's status",
    description:
      "Status, versions, play stats, check results and reviewer notes for one of your games, by slug (from list_my_games).",
    inputSchema: { slug: z.string() },
    annotations: { readOnlyHint: true },
  },
  tool(async ({ slug }) => {
    const game = await api.getGame(slug);
    return text(`${summarizeGame(game)}\n\nFull detail:\n${JSON.stringify(game, null, 2)}`);
  })
);

server.registerPrompt(
  "make_arcade_game",
  {
    title: "Make a Scareathon arcade game",
    description: "Walks through building, hosting and submitting a game for the Scareathon arcade.",
    argsSchema: { idea: z.string().optional().describe("What the game is about") },
  },
  ({ idea }) => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text:
            `Make a game for the Scareathon arcade${idea ? `: ${idea}` : ""}.\n\n` +
            "1. Call get_arcade_spec and follow it exactly (score hookup, sandbox and content rules).\n" +
            "   If I'm not signed in yet, call sign_in and show me the link.\n" +
            "2. Build it as a static web page that resizes to fit, with touch controls if it should work on phones.\n" +
            "3. Host it on https (GitHub Pages is easiest) and give me the URL.\n" +
            "4. Run validate_game and fix anything that fails.\n" +
            "5. Ask me before calling submit_game, then tell me where to play the draft.",
        },
      },
    ],
  })
);

await server.connect(new StdioServerTransport());
