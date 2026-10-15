"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ORDERS } from "@/lib/orders";
import { useVoiceAgent, type AgentState, type TranscriptEntry } from "@/lib/useVoiceAgent";

const STATE_LABEL: Record<AgentState, string> = {
  idle: "Ready to call",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  ended: "Call ended",
  error: "Couldn't connect",
};

const STATE_HINT: Record<AgentState, string> = {
  idle: "Press Start Call and allow microphone access.",
  connecting: "Getting a secure session and opening your mic.",
  listening: "Go ahead, Aria is listening.",
  thinking: "Aria is working on a reply.",
  speaking: "You can interrupt her at any time.",
  ended: "Your transcript and summary are below.",
  error: "See the message below and try again.",
};

const SCENARIOS = [
  { label: "Track an order", say: "Hi, where is my order ORD-101?" },
  { label: "Cancel (allowed)", say: "I want to cancel my order ORD-103." },
  { label: "Return (outside policy)", say: "I bought ORD-102 a while ago and opened it. Can I return it?" },
  { label: "Invalid order ID", say: "Can you check order ORD-999 for me?" },
  { label: "Out of scope", say: "Can you book me a flight to Goa?" },
  { label: "Policy question", say: "Is cash on delivery available for a 3000 rupee order?" },
  { label: "Hinglish", say: "Mera order ORD-101 kab tak aayega?" },
];

const STATUS_TONE: Record<string, string> = {
  "Out for Delivery": "tone-amber",
  Delivered: "tone-green",
  Processing: "tone-blue",
  Shipped: "tone-amber",
};

function fmtTime(s: number) {
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function toolLine(e: TranscriptEntry) {
  const t = e.tool!;
  const arg = Object.entries(t.args)
    .map(([k, v]) => (k === "order_id" ? String(v) : `${k}: ${String(v)}`))
    .join(", ");
  const r = t.result;
  let outcome = "running…";
  if (r) {
    if (r.error) outcome = String(r.error).replace(/_/g, " ").toLowerCase();
    else if (t.name === "get_order_details") outcome = `found · ${r.status}`;
    else if (t.name === "check_policy_eligibility")
      outcome = r.eligible === true ? "eligible" : r.eligible === false ? "not eligible" : "needs more info";
    else if (t.name === "cancel_order") outcome = r.cancelled ? `cancelled · ${r.cancellation_ref}` : "refused";
    else if (t.name === "create_support_ticket") outcome = `ticket ${r.ticket_id}`;
    else if (t.name === "end_call") outcome = r.ok === false ? "blocked · customer hasn't answered" : "hanging up";
  }
  return {
    call: `${t.name}(${arg})`,
    outcome,
    failed: Boolean(r?.error) || r?.eligible === false || r?.cancelled === false || r?.ok === false,
  };
}

export default function CallConsole() {
  const agent = useVoiceAgent();
  const { state, entries, error, elapsed, avgLatency, latencies, outcome, summarising, micLevel, agentLevel } = agent;
  const [typed, setTyped] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLElement>(null);

  const inCall = state === "listening" || state === "thinking" || state === "speaking";
  const busy = state === "connecting";

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  useEffect(() => {
    if (outcome) summaryRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [outcome]);

  const level = state === "speaking" ? agentLevel * 3 : state === "listening" ? micLevel * 6 : 0;
  const orbScale = 1 + Math.min(level, 0.6) * 0.35;

  const outcomeJson = useMemo(() => {
    if (!outcome) return "";
    const s = outcome.summary ?? {};
    const ordered = {
      customer_intent: s.customer_intent,
      order_id: s.order_id ?? null,
      resolution_status: s.resolution_status,
      call_summary: s.call_summary,
      secondary_intents: s.secondary_intents,
      policy_applied: s.policy_applied,
      actions_taken: s.actions_taken,
      customer_sentiment: s.customer_sentiment,
      follow_up_required: s.follow_up_required,
      call_metadata: { ...outcome.meta, summary_generated_by: outcome.source ?? "unavailable" },
    };
    return JSON.stringify(ordered, null, 2);
  }, [outcome]);

  const transcriptText = useMemo(
    () =>
      entries
        .filter((e) => e.role === "tool" || /[\p{L}\p{N}]/u.test(e.text))
        .map((e) => {
          const ts = fmtTime(Math.floor(e.at / 1000));
          if (e.role === "tool") {
            const t = toolLine(e);
            return `[${ts}] TOOL      ${t.call} -> ${t.outcome}`;
          }
          const who = e.role === "customer" ? "CUSTOMER" : "ARIA    ";
          return `[${ts}] ${who}  ${e.text.trim()}${e.interrupted ? " [interrupted]" : ""}${e.typed ? " [typed]" : ""}`;
        })
        .join("\n"),
    [entries],
  );

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1400);
    } catch {}
  };

  const download = (text: string, name: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const sendTyped = (text: string) => {
    agent.sendText(text);
    setTyped("");
  };

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            ✺
          </span>
          <div>
            <div className="brand-name">aura</div>
            <div className="brand-sub">skincare · customer care</div>
          </div>
        </div>
        <div className="topbar-meta">
          <span className="chip">Voice agent demo</span>
          <span className="chip chip-quiet">Gemini Live · speech-to-speech</span>
        </div>
      </header>

      <main className="grid">
        {/* ---------------- Call panel ---------------- */}
        <section className="card call" aria-label="Call">
          <div className="call-head">
            <div>
              <h1>Talk to Aria</h1>
              <p className="muted">Aura&rsquo;s support specialist. Ask about an order, delivery, returns or cancellations.</p>
            </div>
            <div className="call-stats">
              <div className="stat">
                <span className="stat-k">Duration</span>
                <span className="stat-v mono">{fmtTime(elapsed)}</span>
              </div>
              <div className="stat">
                <span className="stat-k">Avg response</span>
                <span className="stat-v mono">{avgLatency ? `${(avgLatency / 1000).toFixed(2)}s` : "—"}</span>
              </div>
            </div>
          </div>

          <div className={`stage state-${state}`}>
            <div className="orb-wrap" aria-hidden>
              <div className="orb-ring" />
              <div className="orb" style={{ transform: `scale(${orbScale})` }} />
            </div>
            <div className="stage-text" role="status" aria-live="polite">
              <div className="stage-label">{STATE_LABEL[state]}</div>
              <div className="stage-hint">{STATE_HINT[state]}</div>
            </div>

            <ol className="states" aria-label="Agent state">
              {(["listening", "thinking", "speaking"] as const).map((s) => (
                <li key={s} className={state === s ? "on" : ""}>
                  <span className="dot" />
                  {STATE_LABEL[s]}
                </li>
              ))}
            </ol>

            <div className="actions">
              {!inCall ? (
                <button className="btn btn-primary" onClick={agent.start} disabled={busy}>
                  {busy ? "Connecting…" : state === "ended" || state === "error" ? "Start new call" : "Start Call"}
                </button>
              ) : (
                <button className="btn btn-danger" onClick={agent.end}>
                  End Call
                </button>
              )}
            </div>
            <p className="tiny muted">Headphones give the cleanest interruptions. Chrome or Edge recommended.</p>
          </div>

          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}

          <div className="transcript-head">
            <h2>Live transcript</h2>
            {latencies.length > 0 && <span className="tiny muted mono">last reply {(latencies[latencies.length - 1] / 1000).toFixed(2)}s</span>}
          </div>
          <div className="transcript" ref={listRef}>
            {entries.length === 0 && <p className="empty">The conversation will appear here as you speak.</p>}
            {entries.filter((e) => e.role === "tool" || /[\p{L}\p{N}]/u.test(e.text)).map((e) =>
              e.role === "tool" ? (
                <ToolRow key={e.id} e={e} />
              ) : (
                <div key={e.id} className={`msg msg-${e.role}`}>
                  <span className="msg-who">{e.role === "customer" ? (e.typed ? "You (typed)" : "You") : "Aria"}</span>
                  <p>
                    {e.text.trim()}
                    {e.interrupted && <span className="cut"> — interrupted</span>}
                  </p>
                </div>
              ),
            )}
          </div>

          <form
            className="typebox"
            onSubmit={(ev) => {
              ev.preventDefault();
              sendTyped(typed);
            }}
          >
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={inCall ? "Mic not cooperating? Type a message to Aria…" : "Start a call to type or speak"}
              disabled={!inCall}
              aria-label="Type a message"
            />
            <button className="btn btn-ghost" disabled={!inCall || !typed.trim()}>
              Send
            </button>
          </form>
        </section>

        {/* ---------------- Helper column ---------------- */}
        <aside className="side">
          <section className="card">
            <h2>Test orders</h2>
            <p className="muted small">Use these IDs on the call. Any other ID is treated as not found.</p>
            <ul className="orders">
              {ORDERS.map((o) => (
                <li key={o.order_id} className="order">
                  <div className="order-top">
                    <button className="order-id mono" onClick={() => copy(o.order_id, o.order_id)} title="Copy order ID">
                      {o.order_id}
                      <span className="copy">{copied === o.order_id ? "copied" : "copy"}</span>
                    </button>
                    <span className={`status ${STATUS_TONE[o.status] ?? ""}`}>{o.status}</span>
                  </div>
                  <div className="order-product">{o.product}</div>
                  <div className="order-meta">
                    <span>{o.customer_name}</span>
                    <span>₹{o.value_inr}</span>
                    {o.tracking_id && <span className="mono">{o.tracking_id}</span>}
                  </div>
                  <div className="order-note">{o.delivery_note}</div>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Things to try</h2>
            <p className="muted small">Say these out loud. During a call you can also tap one to send it as text.</p>
            <ul className="scenarios">
              {SCENARIOS.map((s) => (
                <li key={s.label}>
                  <button className="scenario" disabled={!inCall} onClick={() => sendTyped(s.say)}>
                    <span className="scenario-label">{s.label}</span>
                    <span className="scenario-say">&ldquo;{s.say}&rdquo;</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <details className="card policies">
            <summary>
              <h2>Brand policies Aria follows</h2>
            </summary>
            <dl>
              <dt>Shipping</dt>
              <dd>Free above ₹499, else ₹50. Delivery in 3–5 business days.</dd>
              <dt>Returns</dt>
              <dd>Within 7 days of delivery, unopened and unused, original packaging.</dd>
              <dt>Damaged items</dt>
              <dd>Report within 48 hours of delivery with photos for a replacement.</dd>
              <dt>Cancellation</dt>
              <dd>Only while Processing. Once shipped, the customer may refuse delivery.</dd>
              <dt>Cash on delivery</dt>
              <dd>Orders up to ₹2,500. Cash or UPI at the doorstep.</dd>
            </dl>
          </details>
        </aside>

        {/* ---------------- Post-call ---------------- */}
        {(summarising || outcome) && (
          <section className="card summary" ref={summaryRef} aria-label="Call summary">
            <div className="summary-head">
              <h2>Post-call summary</h2>
              {outcome?.summary && (
                <div className="badges">
                  <span className="badge">{String(outcome.summary.customer_intent ?? "")}</span>
                  <span className={`badge badge-${String(outcome.summary.resolution_status ?? "").toLowerCase()}`}>
                    {String(outcome.summary.resolution_status ?? "")}
                  </span>
                </div>
              )}
            </div>
            {summarising && <p className="muted">Analysing the call…</p>}
            {outcome && (
              <div className="summary-grid">
                <div>
                  <div className="pane-head">
                    <h3>Structured outcome (JSON)</h3>
                    <div className="pane-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => copy(outcomeJson, "json")}>
                        {copied === "json" ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => download(outcomeJson, `${outcome.meta.call_id}.json`, "application/json")}
                      >
                        Download
                      </button>
                    </div>
                  </div>
                  {outcome.summary?.call_summary != null && <p className="summary-lead">{String(outcome.summary.call_summary)}</p>}
                  <pre className="json mono">{outcomeJson}</pre>
                </div>
                <div>
                  <div className="pane-head">
                    <h3>Call transcript</h3>
                    <div className="pane-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => copy(transcriptText, "tx")}>
                        {copied === "tx" ? "Copied" : "Copy"}
                      </button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => download(transcriptText, `${outcome.meta.call_id}-transcript.txt`, "text/plain")}
                      >
                        Download
                      </button>
                    </div>
                  </div>
                  <pre className="log mono">{transcriptText || "No conversation was captured."}</pre>
                </div>
              </div>
            )}
          </section>
        )}
      </main>

      <footer className="foot muted tiny">
        Demo build for the Datastraw AI Voice Agent assignment. Aura Skincare is a fictional brand; orders are mock data.
      </footer>
    </div>
  );
}

function ToolRow({ e }: { e: TranscriptEntry }) {
  const t = toolLine(e);
  return (
    <div className={`toolrow ${t.failed ? "toolrow-warn" : ""}`}>
      <span className="toolrow-tag">tool</span>
      <code className="mono">{t.call}</code>
      <span className="toolrow-arrow">→</span>
      <span className="toolrow-out">{t.outcome}</span>
    </div>
  );
}
