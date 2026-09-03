// Server-side bridge to rielty's public MCP server.
//
// The browser cannot talk to https://rielty.co.uk/mcp/v1 directly: that
// endpoint sends no CORS headers, its OPTIONS preflight is a 405, and the
// `mcp-session-id` the handshake depends on is not in
// Access-Control-Expose-Headers. So the page calls this function instead, and
// this function speaks MCP.
//
// The endpoint is anonymous and read-only, so there is no key to keep secret
// here — this exists to cross the origin boundary, not to hide a credential.

const MCP_URL = "https://rielty.co.uk/mcp/v1";
const PROTOCOL_VERSION = "2025-06-18";

// The four tools rielty publishes. Anything else is rejected before it leaves
// this machine — an open relay to someone else's MCP server is not a feature.
const ALLOWED = new Set([
  "search_properties",
  "property_details",
  "area_report",
  "estimate_value",
]);

// A warm Lambda reuses this; a cold one pays the handshake again. Sessions do
// expire server-side, so `call()` re-handshakes once on rejection rather than
// trusting the cache.
// ponytail: module-scoped single session, fine because every visitor's request
// is anonymous and read-only. Key it per visitor if the endpoint ever
// personalises its answers.
let session = null;

async function rpc(body, sessionId) {
  const headers = {
    "content-type": "application/json",
    // The streamable-HTTP transport rejects a request that does not accept
    // BOTH of these in one header, with a 406.
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  return res;
}

async function handshake() {
  const initRes = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "rielty-move-board", version: "1.0.0" },
    },
  });

  if (!initRes.ok) throw new Error(`initialize failed: HTTP ${initRes.status}`);

  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("initialize returned no mcp-session-id");

  // Without this notification every later call is refused with
  // -32600 "Server not initialized". The handshake is two round trips.
  await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);

  return sessionId;
}

async function callOnce(name, args, sessionId) {
  const res = await rpc(
    {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    },
    sessionId,
  );

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`rielty returned non-JSON (HTTP ${res.status})`);
  }
  return { res, payload };
}

async function call(name, args) {
  if (!session) session = await handshake();

  let { res, payload } = await callOnce(name, args, session);

  // A session the server has forgotten looks like a JSON-RPC error, not a
  // transport failure — so retry the handshake once before giving up.
  if (payload?.error || !res.ok) {
    session = await handshake();
    ({ res, payload } = await callOnce(name, args, session));
  }

  if (payload?.error) {
    throw new Error(payload.error.message || "rielty rejected the call");
  }

  // MCP wraps a tool's answer as a content block whose text is itself JSON.
  const block = payload?.result?.content?.[0]?.text;
  if (typeof block !== "string") {
    throw new Error("rielty returned no content block");
  }

  try {
    return JSON.parse(block);
  } catch {
    // A tool that answers in prose rather than JSON is still a valid answer.
    return { text: block };
  }
}

export default async (req) => {
  const json = (status, body) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });

  let body;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: "body must be JSON" });
  }

  const { tool, arguments: args } = body || {};
  if (!ALLOWED.has(tool)) {
    return json(400, { ok: false, error: `unknown tool: ${tool}` });
  }
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
    return json(400, { ok: false, error: "arguments must be an object" });
  }

  try {
    const result = await call(tool, args || {});
    return json(200, { ok: true, result });
  } catch (err) {
    // The page turns this into a card the human can see, so say something a
    // person could act on rather than leaking a stack trace.
    return json(200, { ok: false, error: String(err.message || err) });
  }
};

export const config = { path: "/api/mcp" };
