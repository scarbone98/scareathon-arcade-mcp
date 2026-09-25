# Scareathon Arcade MCP server

Lets your AI make games for the [Scareathon arcade](https://www.scareathon.rip/arcade) and submit them as you.

It's an [MCP](https://modelcontextprotocol.io) server: a small program your AI app (Claude Code, Claude Desktop,
Cursor, ...) starts in the background, giving the AI a few extra tools. Everything the AI submits is saved as a
**draft**. Only you and the admins can play it until an admin approves it for the shelf.

## Setup

**Claude Code**

```sh
claude mcp add scareathon-arcade -- npx -y github:scarbone98/scareathon-arcade-mcp
```

**Claude Desktop, Cursor and other MCP clients**: add this to the app's MCP config (for Claude Desktop that's
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "scareathon-arcade": {
      "command": "npx",
      "args": ["-y", "github:scarbone98/scareathon-arcade-mcp"]
    }
  }
}
```

Needs Node.js 18 or newer. That's it: no passwords, tokens or keys go in the config.

Then ask your AI something like *"Make a spooky Scareathon arcade game, host it on GitHub Pages and submit it."*
Clients that support MCP prompts also have a `make_arcade_game` prompt.

## Signing in

The first time the AI needs your account, it calls `sign_in` and gives you a link and a code, like
`https://www.scareathon.rip/arcade/connect?code=WXYZ-2345`:

1. Open the link and sign in to Scareathon if asked.
2. Check the code matches the one your AI showed you.
3. Click **Approve**.

The server then gets a token for your account and saves it on your computer, readable only by you:

- `~/.config/scareathon-arcade-mcp/credentials.json` (Linux and macOS)
- `%APPDATA%\scareathon-arcade-mcp\credentials.json` (Windows)

That token:
- can only submit games and read your own games; it can't spend coins, post, message anyone or change your account.
- shows up under **Connected AIs** on https://www.scareathon.rip/arcade/create, where you can disconnect it.
- is revoked when the AI calls `sign_out`.

Only approve a sign-in you just started yourself. If someone sends you a link, decline it.

## Tools

| tool | what it does |
|---|---|
| `sign_in` | Connects to your Scareathon account (see above). Call again with `waitSeconds` to wait for your approval. |
| `sign_out` | Disconnects and forgets the saved sign-in. |
| `whoami` | Which account it's signed in as. |
| `get_arcade_spec` | The rules a game must follow: hosting, sandbox, content, the score hookup script and the manifest format. |
| `validate_game` | Dry run: checks the manifest and the game URL (loads, is HTML, can be framed). Saves nothing. |
| `submit_game` | Submits as you. A new name makes a new game; one of your games' names makes a new version. Always a draft. |
| `list_my_games` | Your games, every version's status (draft, live, approved, rejected, replaced) and reviewer notes. |
| `get_game_status` | One game in detail, by slug. |

## How versions work

- Every submit is a new **draft** version, and an admin reviews it.
- Once approved, it's what players get.
- Submitting an update while a game is live doesn't change what players see: they keep the last approved version
  until the new one is approved.
- Submitting again before review replaces the waiting draft.

## Development

```sh
npm install
npm test
# Against a local Scareathon server, with a separate sign-in
SCAREATHON_API_URL=http://localhost:3000 npx @modelcontextprotocol/inspector node index.js
```

Optional environment variables:

| variable | what it does |
|---|---|
| `SCAREATHON_API_URL` | Use another Scareathon API (default: the live one). |
| `SCAREATHON_CREDENTIALS_FILE` | Keep the sign-in somewhere else. |
| `SCAREATHON_TOKEN` | Use this arcade token instead of signing in (automation only; keep it out of anything you share). |

The spec, validation and review all live on the Scareathon server (`GET /arcade/spec`), so spec changes don't need a
new version of this package.
