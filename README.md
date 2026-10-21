<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="packages/extension/src/assets/skimlet-logo.svg" alt="Skimlet logo" width="128">
</p>

<h1 align="center">Skimlet</h1>
<!-- markdownlint-enable MD033 MD041 -->

Skimlet is a local MCP server for agents doing deep research. It reads
search engine results pages (SERPs) and extracts page content in batches
using your Chrome profile. Google is the first supported source; Brave, Bing,
and Reddit are planned.

Skimlet can visit 1,000 pages and provide extracted content for your agent
to summarize within five minutes (machine used: MacBook Pro M5).

Requires Node.js 22+ and Chrome 125+.

## Setup

Choose one way to start the MCP server. Both use the separate Chrome
extension described below.

### Local checkout

```sh
npm ci
npm run check
npm test
npm run build
```

For MCP clients that use `mcpServers` JSON, provide an absolute path to your
checkout:

```json
{
  "mcpServers": {
    "skimlet": {
      "command": "node",
      "args": ["/absolute/path/to/skimlet-final/packages/mcp/dist/mcp.js"]
    }
  }
}
```

### Published npm package

Run the published package with `npx`. No global install is required:

```json
{
  "mcpServers": {
    "skimlet": {
      "command": "npx",
      "args": ["-y", "@bhoomabrsr/skimlet"]
    }
  }
}
```

### Chrome extension

The npm package does not contain the extension. Clone this repository and run
`npm ci && npm run build:extension` if you have not built it from source.

In the Chrome profile you want to use, open `chrome://extensions`, enable
**Developer mode**, select **Load unpacked**, and choose
`packages/extension/dist/`. With the MCP server running, click the Skimlet
icon on a web page to attach that tab. Click it again to detach. If the
server starts after the extension, click the icon to reconnect. Skimlet
creates and groups its own tabs for MCP searches and closes them when the
session ends.

## Search examples

Pass these JSON arguments to the MCP `search` tool.

Search results without opening linked pages:

```json
{
  "queries": ["TypeScript Playwright"],
  "includeContent": false
}
```

Search results with extracted page content:

```json
{
  "queries": ["TypeScript Playwright"],
  "format": "markdown",
  "maxContentChars": 20000
}
```

Set your MCP client's tool timeout to at least 150 seconds. To adjust the
number of concurrent worker tabs, set `SKIMLET_TABS` to a value from 1 to 20
(default: 5) in the MCP server's environment.

## Scope and security

The extension requests `activeTab`, `debugger`, and `tabGroups`. It has no
all-URL host permissions, content scripts, toolbar injection, or credential
storage. The relay binds to loopback and checks the extension's origin
against its public-key-derived ID. This does not protect against other
local processes running as you. Use trusted MCP clients only: browser
requests may include your profile cookies, and extracted page content is
returned to the client. The relay uses Playwriter 0.8.0 as an npm dependency;
the Chrome extension is Skimlet's own build.

A real browser can help with some bot checks, but it cannot guarantee that
you will avoid CAPTCHAs.

## Acknowledgements

Skimlet builds on the work of [Playwriter](https://github.com/remorses/playwriter)
and its maintainer, Tommaso De Rossi. Playwriter provides the browser
connection and relay that Skimlet uses, and its Chrome extension architecture
helped shape this project. Thank you for making that work available.
