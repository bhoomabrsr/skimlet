<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <img src="packages/extension/src/assets/skimlet-logo.svg" alt="Skimlet logo" width="128">
</p>

<h1 align="center">Skimlet</h1>
<!-- markdownlint-enable MD033 MD041 -->

Skimlet is a local Model Context Protocol (MCP) server for agents doing deep research. It reads
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
      "args": ["/absolute/path/to/skimlet-final/packages/skimlet/dist/mcp/mcp.js"]
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

Install [Skimlet from the Chrome Web Store](https://chromewebstore.google.com/detail/skimlet/fiipfignceankihmkhfjldmniofechoh)
in the Chrome profile you want to use. If you lack Store access, clone
this repository, run `npm ci && npm run build:extension`, and load
`packages/extension/dist/` through **Load unpacked** in `chrome://extensions`.
The relay accepts both extension IDs.

Start an MCP client, then select the Skimlet icon on a web page to attach that
tab. Select it again to detach. The relay stays online when an MCP client
exits. If the relay restarts, select the icon to reconnect. Skimlet closes
the tabs it creates when their MCP session ends.

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
with the Store ID or the unpacked build's manifest-derived ID. Other local
processes with your user account can still reach the relay. Use trusted MCP
clients only: browser requests can include your profile cookies, and MCP clients
receive extracted page content. Skimlet owns its extension, relay, and browser
connector. `/version.version` reports Skimlet's package version. The MCP server
uses Playwright Core for today's searches. The relay keeps a compatible
Chrome DevTools Protocol (CDP) command interface for future browser interactions.

A real browser can help with some bot checks, but it cannot guarantee that
you will avoid CAPTCHAs.

## Acknowledgements

Skimlet builds on the work of [Playwriter](https://github.com/remorses/playwriter)
and its maintainer, Tommaso De Rossi. Playwriter's extension and CDP design
helped shape Skimlet's protocol. The current search flow has no Playwriter
runtime dependency.
