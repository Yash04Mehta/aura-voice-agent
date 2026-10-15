// The model asks for a tool in the browser; the browser forwards it here.
// Order data and policy logic stay on the server, like a real backend would.

import { TOOL_HANDLERS, runTool } from "@/lib/orders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { name?: unknown; args?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name : "";
  if (!TOOL_HANDLERS[name]) {
    return Response.json({ error: "UNKNOWN_TOOL", name }, { status: 400 });
  }
  const args = body.args && typeof body.args === "object" ? (body.args as Record<string, unknown>) : {};
  return Response.json({ result: runTool(name, args) });
}
