#!/usr/bin/env node
// A stand-in for Microsoft.CodeAnalysis.LanguageServer that speaks just enough of the protocol over stdio for the
// confirmation to run against: initialize, project and solution loading, and pull diagnostics. A file under a
// `broken` folder has one compile error, and a file under `old-error` has one in every tree, so tests can tell a
// new error from one that was already there.
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

function handle(message) {
  switch (message.method) {
    case "initialize":
      send({ id: message.id, result: { capabilities: { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } } } });
      return;
    case "solution/open":
    case "project/open":
      // The server first asks the client something, as the real one does, and then reports the load as complete.
      send({ id: 900, method: "client/registerCapability", params: { registrations: [] } });
      send({ method: "workspace/projectInitializationComplete", params: {} });
      return;
    case "textDocument/diagnostic": {
      const uri = message.params.textDocument.uri;
      const items = [];
      if (uri.includes("/broken/")) items.push({ severity: 1, code: "CS0246", message: "The type or namespace name 'Money' could not be found", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } });
      if (uri.includes("old-error")) items.push({ severity: 1, code: "CS0103", message: "The name 'x' does not exist in the current context", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } });
      items.push({ severity: 2, code: "CS0168", message: "A warning is not an error", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 1 } } });
      send({ id: message.id, result: { kind: "full", items } });
      return;
    }
    case "shutdown":
      send({ id: message.id, result: null });
      return;
    case "exit":
      process.exit(0);
      return;
    default:
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, separator).toString("ascii"))[1]);
    const end = separator + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(separator + 4, end).toString("utf8"));
    buffer = buffer.subarray(end);
    handle(message);
  }
});
