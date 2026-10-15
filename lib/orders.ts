// Mock order database + the business logic behind every tool the agent can call.
//
// Design rule: the LLM never decides whether something is allowed by policy.
// It calls a tool, and this file returns an explicit verdict (eligible: true/false
// plus a reason). The model's job is only to explain that verdict kindly.
// That is the main guardrail against the agent "agreeing" to refunds it can't give.

export type OrderStatus = "Processing" | "Shipped" | "Out for Delivery" | "Delivered";

export interface Order {
  order_id: string;
  customer_name: string;
  product: string;
  value_inr: number;
  status: OrderStatus;
  payment: string;
  courier?: string;
  tracking_id?: string;
  /** Free-text delivery note, as a support agent would see it */
  delivery_note: string;
  /** Days since delivery (only for Delivered orders) */
  delivered_days_ago?: number;
  /** Hours since the order was placed */
  ordered_hours_ago?: number;
}

export const ORDERS: Order[] = [
  {
    order_id: "ORD-101",
    customer_name: "Priya Sharma",
    product: "Vitamin C Serum (30ml)",
    value_inr: 699,
    status: "Out for Delivery",
    payment: "Prepaid",
    courier: "BlueDart",
    tracking_id: "BD-982103",
    delivery_note: "Out for delivery with BlueDart. Expected by 6 PM today.",
  },
  {
    order_id: "ORD-102",
    customer_name: "Rahul Verma",
    product: "Hydrating Sunscreen SPF 50",
    value_inr: 499,
    status: "Delivered",
    payment: "Prepaid",
    courier: "Delhivery",
    tracking_id: "DL-441029",
    delivery_note: "Delivered by Delhivery 14 days ago.",
    delivered_days_ago: 14,
  },
  {
    order_id: "ORD-103",
    customer_name: "Ananya Patel",
    product: "Green Tea Face Wash + Toner",
    value_inr: 850,
    status: "Processing",
    payment: "Prepaid",
    delivery_note: "Ordered 3 hours ago. Not yet shipped.",
    ordered_hours_ago: 3,
  },
];

// ---------------------------------------------------------------------------
// Order ID normalisation (graceful degradation for speech input)
// ---------------------------------------------------------------------------

const SPOKEN_DIGITS: Record<string, string> = {
  // Ambiguous words like "oh", "to", "for", "do" are left out on purpose:
  // "Oh, my order is 101" must not become ORD-0101.
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6",
  seven: "7", eight: "8", nine: "9",
  ek: "1", teen: "3", char: "4", paanch: "5", chhe: "6", saat: "7", aath: "8", nau: "9", shunya: "0",
};

/**
 * Speech-to-text turns "ORD-101" into many shapes: "ord 101", "order one zero one",
 * "O R D 1 0 1", "101". We pull out the digits and rebuild the canonical ID.
 * Returns null when no plausible ID can be recovered.
 */
export function normalizeOrderId(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).toLowerCase();
  let digits = "";
  for (const token of text.split(/[^a-z0-9]+/).filter(Boolean)) {
    if (/^\d+$/.test(token)) digits += token;
    else if (/^ord\d+$/.test(token)) digits += token.slice(3);
    else if (/^(zero|one|two|three|four|five|six|seven|eight|nine|ek|teen|char|paanch|chhe|saat|aath|nau|shunya)$/.test(token)) {
      digits += SPOKEN_DIGITS[token];
    }
  }
  if (!digits) return null;
  return `ORD-${digits}`;
}

function findOrder(rawId: unknown): { id: string | null; order?: Order } {
  const id = normalizeOrderId(rawId);
  if (!id) return { id: null };
  return { id, order: ORDERS.find((o) => o.order_id === id) };
}

const MISSING_ID = {
  found: false,
  error: "MISSING_ORDER_ID",
  instruction: "Ask the customer for their order ID. It looks like ORD followed by three digits, for example ORD-101.",
};

function notFound(id: string) {
  return {
    found: false,
    error: "ORDER_NOT_FOUND",
    searched_for: id,
    instruction:
      "No order exists with this ID. Do not guess or invent details. Tell the customer you couldn't locate it, read back the ID you heard, and ask them to repeat or check it.",
  };
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export function getOrderDetails(args: { order_id?: unknown }) {
  const { id, order } = findOrder(args.order_id);
  if (!id) return MISSING_ID;
  if (!order) return notFound(id);

  return {
    found: true,
    order_id: order.order_id,
    customer_name: order.customer_name,
    product: order.product,
    value_inr: order.value_inr,
    status: order.status,
    payment: order.payment,
    courier: order.courier ?? null,
    tracking_id: order.tracking_id ?? null,
    delivery_note: order.delivery_note,
    can_cancel: order.status === "Processing",
  };
}

type Action = "cancel" | "return" | "damage_replacement";

export function checkPolicyEligibility(args: {
  order_id?: unknown;
  action?: unknown;
  product_opened?: unknown;
}) {
  const { id, order } = findOrder(args.order_id);
  if (!id) return MISSING_ID;
  if (!order) return notFound(id);

  const action = String(args.action ?? "").toLowerCase() as Action;
  const base = { order_id: order.order_id, status: order.status, action };

  if (action === "cancel") {
    if (order.status === "Processing") {
      return {
        ...base,
        eligible: true,
        reason: "Order is still Processing, so it can be cancelled.",
        next_step: "Confirm with the customer that they want to cancel, then call cancel_order.",
      };
    }
    return {
      ...base,
      eligible: false,
      reason: `Orders can only be cancelled while Processing. This order is already ${order.status}.`,
      alternative:
        order.status === "Delivered"
          ? "The order is already delivered, so the return policy applies instead."
          : "The customer may refuse the delivery at the doorstep.",
    };
  }

  if (action === "return") {
    if (order.status !== "Delivered") {
      return {
        ...base,
        eligible: false,
        reason: "A return is only possible after delivery. This order has not been delivered yet.",
        alternative:
          order.status === "Processing"
            ? "The order can still be cancelled instead."
            : "The customer may refuse the delivery at the doorstep.",
      };
    }
    const days = order.delivered_days_ago ?? 0;
    if (days > 7) {
      return {
        ...base,
        eligible: false,
        days_since_delivery: days,
        reason: `Returns are accepted within 7 days of delivery. This order was delivered ${days} days ago, so the return window has closed.`,
      };
    }
    if (args.product_opened === true) {
      return {
        ...base,
        eligible: false,
        days_since_delivery: days,
        reason: "Returns are accepted only for unopened, unused products in original packaging.",
      };
    }
    if (args.product_opened !== false) {
      return {
        ...base,
        eligible: "needs_info",
        days_since_delivery: days,
        reason: "Within the 7-day window. Eligibility depends on the product being unopened and unused.",
        instruction: "Ask whether the product is unopened and in its original packaging, then call this tool again with product_opened.",
      };
    }
    return {
      ...base,
      eligible: true,
      days_since_delivery: days,
      reason: "Delivered within 7 days and unopened, so it qualifies for a return.",
      next_step: "Call create_support_ticket so the returns team can arrange pickup.",
    };
  }

  if (action === "damage_replacement") {
    if (order.status !== "Delivered") {
      return {
        ...base,
        eligible: false,
        reason: "Damage can only be reported once the order has been delivered.",
      };
    }
    const hours = (order.delivered_days_ago ?? 0) * 24;
    if (hours > 48) {
      return {
        ...base,
        eligible: false,
        hours_since_delivery: hours,
        reason: "Damaged or defective products must be reported within 48 hours of delivery. This window has passed.",
      };
    }
    return {
      ...base,
      eligible: true,
      reason: "Reported within 48 hours. A replacement is possible once photos are shared.",
      next_step: "Call create_support_ticket and tell the customer to reply with photos of the damage.",
    };
  }

  return {
    ...base,
    eligible: false,
    error: "UNKNOWN_ACTION",
    instruction: "Use one of: cancel, return, damage_replacement.",
  };
}

export function cancelOrder(args: { order_id?: unknown }) {
  const verdict = checkPolicyEligibility({ order_id: args.order_id, action: "cancel" });
  if (!("eligible" in verdict) || verdict.eligible !== true) {
    return { cancelled: false, ...verdict };
  }
  const order = ORDERS.find((o) => o.order_id === verdict.order_id)!;
  return {
    cancelled: true,
    order_id: order.order_id,
    cancellation_ref: `CXL-${order.order_id.slice(4)}${Date.now().toString().slice(-4)}`,
    refund_amount_inr: order.value_inr,
    note: "The full order value will be refunded. Exact refund timelines are not available here; offer a support ticket if the customer asks.",
  };
}

export function createSupportTicket(args: { order_id?: unknown; issue_summary?: unknown }) {
  const id = normalizeOrderId(args.order_id);
  return {
    created: true,
    ticket_id: `AURA-${Date.now().toString().slice(-6)}`,
    order_id: id,
    issue_summary: String(args.issue_summary ?? "").slice(0, 300),
    sla: "A specialist will reach out by email within 24 hours.",
  };
}

export const TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_order_details: getOrderDetails,
  check_policy_eligibility: checkPolicyEligibility,
  cancel_order: cancelOrder,
  create_support_ticket: createSupportTicket,
};

export function runTool(name: string, args: Record<string, unknown> = {}) {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return { error: "UNKNOWN_TOOL", name };
  try {
    return handler(args);
  } catch (e) {
    return { error: "TOOL_FAILED", message: e instanceof Error ? e.message : String(e) };
  }
}
