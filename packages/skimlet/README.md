<!-- markdownlint-disable MD033 MD041 -->
<p align="center">
  <!-- markdownlint-disable-next-line MD013 -->
  <img src="https://raw.githubusercontent.com/bhoomabrsr/skimlet/main/packages/extension/src/assets/skimlet-logo.svg" alt="Skimlet logo" width="128">
</p>

<h1 align="center">Skimlet</h1>
<!-- markdownlint-enable MD033 MD041 -->

Skimlet is a local Model Context Protocol (MCP) server for agents doing deep research. It reads
search engine results pages (SERPs) and extracts page content in batches
using your Chrome profile. Google is the first supported source; Brave, Bing,
and Reddit are planned.

Requires Node.js 22+ and Chrome 125+.

## Setup

### Run the MCP server with npm

For MCP clients that use `mcpServers` JSON, run the published package with
`npx`. No global install is required:

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

Or install it globally with `npm install -g @bhoomabrsr/skimlet` and
configure your MCP client to run `skimlet`. MCP instances share one detached
relay on port `19989`. The relay stays online after MCP exits.

Check it with `curl http://127.0.0.1:19989/version`. The `version` field reports
this package's version. To stop the relay, find the process that owns port
`19989`. Confirm it runs `relay-server/server.js` before you stop it.

### Install the Chrome extension

Install [Skimlet from the Chrome Web Store](https://chromewebstore.google.com/detail/skimlet/fiipfignceankihmkhfjldmniofechoh)
in your Chrome profile. If you lack Store access, clone the
[Skimlet repository](https://github.com/bhoomabrsr/skimlet), run
`npm ci && npm run build:extension`, and use **Load unpacked** in
`chrome://extensions` to load `packages/extension/dist/`. The relay accepts
both extension IDs. Start an MCP server, then select the Skimlet icon on a web
page to connect. If the relay restarts, select the icon again to reconnect.

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

The tool accepts up to 10 queries and 10 results per query. Google is the
only supported search source today. Page extraction is optional; the tool
returns content for your agent to summarize. Set your MCP client's tool
timeout to at least 150 seconds.

## Security

The extension uses Chrome's debugger to read pages in your profile. Browser
requests can include your cookies, and the MCP client receives extracted
content. Use trusted MCP clients only. See the
[project README](https://github.com/bhoomabrsr/skimlet#readme) for the full
security notes.

## Acknowledgements

Skimlet's extension and Chrome DevTools Protocol (CDP) bridge build on ideas from [Playwriter](https://github.com/remorses/playwriter)
by Tommaso De Rossi. The browser connector and relay belong to Skimlet.
The source repository retains [Playwriter's MIT notice](https://github.com/bhoomabrsr/skimlet/blob/main/packages/extension/LICENSE-Playwriter.txt).
Skimlet itself is licensed under MIT.
