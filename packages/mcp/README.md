# Skimlet MCP server

Skimlet searches Google and extracts page content through a local Chrome
extension. It runs as an MCP server on Node.js 22 or later.

## Install

```sh
npm install -g @bhoomabrsr/skimlet
```

Configure your MCP client to start `skimlet`, or use
`npx -y @bhoomabrsr/skimlet`. Only one server can use port `19989` at a time.

The Chrome extension is distributed separately from the npm package. To build
it from source, clone [the Skimlet repository](https://github.com/bhoomabrsr/skimlet)
and run `npm ci && npm run build:extension`. Load `packages/extension/dist/`
in `chrome://extensions` with Developer mode enabled. Start the MCP server,
then select the extension icon on a web page to connect.

The `search` tool accepts up to 10 queries and up to 10 results per query.
Google is currently the only supported search source. Page extraction is
optional; the tool returns content for your agent to summarize.

See the [project README](https://github.com/bhoomabrsr/skimlet#readme) for
configuration, security notes, and examples.

Skimlet is licensed under MIT. It uses Playwriter under the separate notice
in the source repository at `packages/extension/LICENSE-Playwriter.txt`.
