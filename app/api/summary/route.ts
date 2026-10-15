// Post-call analysis: one normal (non-live) Gemini call that turns the transcript
// into a structured JSON outcome, constrained by a response schema.
// If that call fails, we fall back to a rule-based summary built from the tool log,
// so the evaluator always gets a result.

import { GoogleGenAI, Type } from "@google/genai";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "gemini-3.5-flash-lite";

const INTENTS = [
  "ORDER_TRACKING",
  "CANCELLATION",
  "RETURN_REFUND",
  "DAMAGED_PRODUCT",
  "SHIPPING_POLICY",
  "PAYMENT_COD",
  "PRODUCT_QUERY",
  "OUT_OF_SCOPE",
  "GENERAL_INQUIRY",
  "NO_INTERACTION",
];
const STATUSES = ["RESOLVED", "POLICY_DECLINED", "ESCALATED", "UNRESOLVED", "INCOMPLETE"];

interface Line {
  role: "customer" | "agent" | "tool";
  text: string;
}
interface ToolLog {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

const schema = {
  type: Type.OBJECT,
  properties: {
    customer_intent: { type: Type.STRING, enum: INTENTS, description: "Primary reason for the call." },
    secondary_intents: { type: Type.ARRAY, items: { type: Type.STRING, enum: INTENTS } },
    order_id: { type: Type.STRING, nullable: true, description: "Main order discussed, canonical form like ORD-101, or null." },
    resolution_status: {
      type: Type.STRING,
      enum: STATUSES,
      description:
        "RESOLVED = customer got what they needed; POLICY_DECLINED = request refused per policy with explanation; ESCALATED = ticket raised; UNRESOLVED = could not help; INCOMPLETE = call ended before resolution.",
    },
    policy_applied: { type: Type.STRING, nullable: true, description: "Which brand policy decided the outcome, if any." },
    actions_taken: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Concrete actions, e.g. 'Looked up ORD-101', 'Cancelled ORD-103 (ref CXL-1031234)'." },
    customer_sentiment: { type: Type.STRING, enum: ["POSITIVE", "NEUTRAL", "NEGATIVE"] },
    follow_up_required: { type: Type.BOOLEAN },
    call_summary: { type: Type.STRING, description: "Two sentences max, past tense, factual." },
  },
  required: [
    "customer_intent",
    "secondary_intents",
    "order_id",
    "resolution_status",
    "policy_applied",
    "actions_taken",
    "customer_sentiment",
    "follow_up_required",
    "call_summary",
  ],
};

export async function POST(req: Request) {
  if (!rateLimit(`summary:${clientIp(req)}`, 30, 60 * 60 * 1000)) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: { transcript?: Line[]; tools?: ToolLog[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const transcript = (body.transcript ?? []).slice(-200);
  const tools = (body.tools ?? []).slice(-50);

  if (!transcript.some((l) => l.role === "customer" && l.text.trim())) {
    return Response.json({ summary: emptyCall(), source: "rules" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const ai = new GoogleGenAI({ apiKey });
      const text = transcript.map((l) => `${l.role.toUpperCase()}: ${l.text}`).join("\n");
      const toolText = tools.map((t) => `${t.name}(${JSON.stringify(t.args)}) -> ${JSON.stringify(t.result)}`).join("\n");

      const res = await ai.models.generateContent({
        model: SUMMARY_MODEL,
        contents: `You are a QA analyst for Aura Skincare customer support. Analyse this voice call between a customer and the AI agent Aria.
Base every field only on what is in the transcript and tool log. Speech transcripts may contain recognition errors; prefer the tool log for order IDs and outcomes.

TRANSCRIPT
${text}

TOOL CALLS
${toolText || "(none)"}`,
        config: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 },
      });

      const summary = JSON.parse(res.text ?? "{}");
      return Response.json({ summary, source: "llm" });
    } catch (e) {
      console.error("Summary model failed, using rules", e);
    }
  }

  return Response.json({ summary: ruleBasedSummary(transcript, tools), source: "rules" });
}

function emptyCall() {
  return {
    customer_intent: "NO_INTERACTION",
    secondary_intents: [],
    order_id: null,
    resolution_status: "INCOMPLETE",
    policy_applied: null,
    actions_taken: [],
    customer_sentiment: "NEUTRAL",
    follow_up_required: false,
    call_summary: "The call ended before the customer said anything.",
  };
}

function ruleBasedSummary(transcript: Line[], tools: ToolLog[]) {
  const last = <T,>(arr: T[], f: (x: T) => boolean) => [...arr].reverse().find(f);
  const orderId = (last(tools, (t) => typeof t.result?.order_id === "string")?.result?.order_id as string) ?? null;
  const cancelled = tools.find((t) => t.name === "cancel_order" && t.result?.cancelled === true);
  const ticket = tools.find((t) => t.name === "create_support_ticket");
  const declined = last(tools, (t) => t.name === "check_policy_eligibility" && t.result?.eligible === false);
  const eligibility = last(tools, (t) => t.name === "check_policy_eligibility");
  const action = eligibility?.args?.action as string | undefined;

  let intent = "GENERAL_INQUIRY";
  if (action === "cancel") intent = "CANCELLATION";
  else if (action === "return") intent = "RETURN_REFUND";
  else if (action === "damage_replacement") intent = "DAMAGED_PRODUCT";
  else if (tools.some((t) => t.name === "get_order_details")) intent = "ORDER_TRACKING";

  let status = "UNRESOLVED";
  if (cancelled) status = "RESOLVED";
  else if (ticket) status = "ESCALATED";
  else if (declined) status = "POLICY_DECLINED";
  else if (tools.some((t) => t.result?.found === true)) status = "RESOLVED";

  const actions = tools.map((t) => {
    const id = (t.result?.order_id as string) ?? (t.args?.order_id as string) ?? "";
    if (t.name === "get_order_details") return t.result?.found ? `Looked up ${id}` : `Order lookup failed for ${t.args?.order_id ?? "missing ID"}`;
    if (t.name === "check_policy_eligibility") return `Checked ${t.args?.action} eligibility for ${id}: ${String(t.result?.eligible)}`;
    if (t.name === "cancel_order") return t.result?.cancelled ? `Cancelled ${id} (ref ${t.result?.cancellation_ref})` : `Cancellation refused for ${id}`;
    return `Raised ticket ${t.result?.ticket_id}`;
  });

  return {
    customer_intent: intent,
    secondary_intents: [],
    order_id: orderId,
    resolution_status: status,
    policy_applied: declined ? String(declined.result?.reason ?? "") : null,
    actions_taken: actions,
    customer_sentiment: "NEUTRAL",
    follow_up_required: Boolean(ticket),
    call_summary:
      actions.length > 0
        ? `Customer called about ${orderId ?? "an enquiry"}. ${actions.join("; ")}.`
        : `Customer had a general conversation of ${transcript.length} turns with no order actions.`,
  };
}
