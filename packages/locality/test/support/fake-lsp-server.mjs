#!/usr/bin/env node
// A language server that speaks just enough LSP over stdio to be driven by the mover's confirmation:
// it answers initialize and shutdown, and publishes diagnostics for each file that is opened.
// The mode is the argument `--mode=<mode>`: "clean" (no diagnostics), "broken" (one unresolved-name error per file),
// "silent" (publishes nothing) or "mute" (never answers initialize, so the client's own time limit is what ends the wait).
const mode = /^--mode=(.*)$/.exec(process.argv.find((argument) => argument.startsWith("--mode=")) ?? "")?.[1] ?? "clean";
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
}

function handle(message) {
  if (message.method === "initialize") {
    if (mode !== "mute") send({ id: message.id, result: { capabilities: {} } });
  } else if (message.method === "shutdown") send({ id: message.id, result: null });
  else if (message.method === "exit") process.exit(0);
  else if (message.method === "textDocument/didOpen" && mode !== "silent") {
    const diagnostics = mode === "broken" ? [{ severity: 1, message: "Ledger cannot be resolved to a type", range: { start: { line: 2, character: 0 }, end: { line: 2, character: 6 } } }] : [];
    send({ method: "textDocument/publishDiagnostics", params: { uri: message.params.textDocument.uri, diagnostics } });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"))[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString("utf8"));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
