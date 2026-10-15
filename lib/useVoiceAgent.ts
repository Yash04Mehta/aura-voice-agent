"use client";

// The call controller. Owns the Gemini Live session, the mic, the speaker,
// the transcript, tool execution and the Listening / Thinking / Speaking state.

import { useCallback, useEffect, useRef, useState } from "react";
import { GoogleGenAI, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import { AudioPlayer, MicStream } from "./audio";

export type AgentState = "idle" | "connecting" | "listening" | "thinking" | "speaking" | "ended" | "error";

export interface TranscriptEntry {
  id: number;
  role: "customer" | "agent" | "tool";
  text: string;
  at: number; // ms since call start
  typed?: boolean;
  interrupted?: boolean;
  tool?: { name: string; args: Record<string, unknown>; result?: Record<string, unknown> };
}

export interface ToolLog {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface CallOutcome {
  summary: Record<string, unknown> | null;
  source?: "llm" | "rules";
  error?: string;
  meta: {
    call_id: string;
    started_at: string;
    duration_seconds: number;
    customer_turns: number;
    agent_turns: number;
    tools_called: string[];
    avg_response_latency_ms: number | null;
    barge_ins: number;
    ended_by: "customer" | "agent" | "connection";
  };
}

const VOICE_THRESHOLD = 0.02; // mic RMS above this counts as the customer talking

export function useVoiceAgent() {
  const [state, setState] = useState<AgentState>("idle");
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [outcome, setOutcome] = useState<CallOutcome | null>(null);
  const [summarising, setSummarising] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [agentLevel, setAgentLevel] = useState(0);

  const session = useRef<Session | null>(null);
  const mic = useRef<MicStream | null>(null);
  const player = useRef<AudioPlayer | null>(null);
  const startedAt = useRef(0);
  const nextId = useRef(1);
  const entriesRef = useRef<TranscriptEntry[]>([]);
  const toolLog = useRef<ToolLog[]>([]);
  const currentCustomer = useRef<number | null>(null);
  const currentAgent = useRef<number | null>(null);
  const awaitingReply = useRef(false);
  const lastVoiceAt = useRef(0);
  const pendingTools = useRef(0);
  const cancelledCalls = useRef(new Set<string>());
  const bargeIns = useRef(0);
  const ending = useRef(false);
  const live = useRef(false);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const latenciesRef = useRef<number[]>([]);
  const lastAudioAt = useRef(0);
  const hangupAt = useRef<number | null>(null); // set when Aria calls end_call
  // Mic stays muted while the greeting plays, so the browser's echo canceller can
  // settle and Aria doesn't "hear" her own greeting through the speakers.
  const greetingDone = useRef(false);
  const greetingStartedAt = useRef(0);
  // Watchdog: occasionally the Live model hears the customer but never replies.
  // If the customer finished speaking and nothing comes back, nudge it once.
  const lastCustomerTextAt = useRef(0);
  const lastAgentActivityAt = useRef(0);
  const nudgedFor = useRef(0);
  const nudgedAt = useRef(0);
  const stuckShown = useRef(false);
  const finishRef = useRef<((by: "customer" | "agent" | "connection", reason?: string) => void) | null>(null);

  // ---------- transcript helpers ----------
  const commit = (next: TranscriptEntry[]) => {
    entriesRef.current = next;
    setEntries(next);
  };
  const now = () => Date.now() - startedAt.current;

  const addEntry = (e: Omit<TranscriptEntry, "id" | "at">) => {
    const id = nextId.current++;
    commit([...entriesRef.current, { ...e, id, at: now() }]);
    return id;
  };
  const appendTo = (id: number, text: string) => {
    commit(entriesRef.current.map((e) => (e.id === id ? { ...e, text: e.text + text } : e)));
  };
  const patch = (id: number, p: Partial<TranscriptEntry>) => {
    commit(entriesRef.current.map((e) => (e.id === id ? { ...e, ...p } : e)));
  };

  // ---------- state derivation (runs every 100 ms) ----------
  const tick = useCallback(() => {
    if (!live.current) return;
    setElapsed(Math.floor(now() / 1000));
    const p = player.current;
    setAgentLevel(p ? p.level() : 0);
    const quietFor = Date.now() - lastVoiceAt.current;
    let next: AgentState = "listening";
    if (p?.playing) next = "speaking";
    else if (pendingTools.current > 0) next = "thinking";
    else if (awaitingReply.current && quietFor > 350) next = "thinking";
    setState((s) => (s === next ? s : next));

    // Watchdog: customer spoke, then 6 s of silence from Aria (no audio, no tool) → nudge once.
    const sinceCustomer = Date.now() - lastCustomerTextAt.current;
    if (
      greetingDone.current &&
      lastCustomerTextAt.current > lastAgentActivityAt.current &&
      nudgedFor.current !== lastCustomerTextAt.current &&
      sinceCustomer > 6000 &&
      Date.now() - lastVoiceAt.current > 2500 &&
      pendingTools.current === 0 &&
      !p?.playing
    ) {
      nudgedFor.current = lastCustomerTextAt.current;
      nudgedAt.current = Date.now();
      console.warn("[aria] no reply after 6 s, nudging the model");
      try {
        session.current?.sendClientContent({
          turns: [{ role: "user", parts: [{ text: "(The customer is waiting for your reply to what they just said. Respond now; if you didn't catch it, ask them to repeat.)" }] }],
          turnComplete: true,
        });
      } catch {}
    }

    // Still nothing 10 s after the nudge: the session has stopped responding
    // (most often the free-tier rate limit). Tell the customer instead of leaving them in silence.
    if (
      nudgedAt.current > 0 &&
      !stuckShown.current &&
      lastAgentActivityAt.current < nudgedAt.current &&
      Date.now() - nudgedAt.current > 10000
    ) {
      stuckShown.current = true;
      console.warn("[aria] model stopped responding after nudge");
      setError("Aria has stopped responding (the AI service may be busy or rate-limited). Please end this call and start a new one.");
    }
    if (lastAgentActivityAt.current > nudgedAt.current && stuckShown.current) {
      stuckShown.current = false;
      setError(null);
    }

    // Open the mic once the greeting has finished playing (10 s safety fallback).
    if (!greetingDone.current) {
      const greetingPlayed = lastAudioAt.current > 0 && !p?.playing && Date.now() - lastAudioAt.current > 400;
      if (greetingPlayed || Date.now() - greetingStartedAt.current > 10000) greetingDone.current = true;
    }

    // Aria asked to hang up: wait until her goodbye has finished playing.
    if (hangupAt.current !== null) {
      const quietAudio = !p?.playing && Date.now() - lastAudioAt.current > 1200;
      if ((quietAudio && Date.now() > hangupAt.current) || Date.now() - hangupAt.current > 10000) {
        hangupAt.current = null;
        finishRef.current?.("agent");
      }
    }
  }, []);

  // ---------- tools ----------
  const runTools = async (msg: LiveServerMessage) => {
    const calls = msg.toolCall?.functionCalls ?? [];
    if (!calls.length) return;
    pendingTools.current += calls.length;
    awaitingReply.current = true;

    const responses = await Promise.all(
      calls.map(async (fc) => {
        const name = fc.name ?? "";
        const args = (fc.args ?? {}) as Record<string, unknown>;
        lastAgentActivityAt.current = Date.now();
        const entryId = addEntry({ role: "tool", text: name, tool: { name, args } });
        let result: Record<string, unknown>;
        if (name === "end_call") {
          // Handled in the browser. Guard: if Aria's last line was a question
          // ("anything else?"), the customer hasn't answered yet, so refuse to hang up.
          const lastSpoken = [...entriesRef.current].reverse().find((e) => e.role !== "tool");
          const askedQuestion = lastSpoken?.role === "agent" && /[?？]\s*$/.test(lastSpoken.text.trim());
          if (askedQuestion) {
            result = {
              ok: false,
              error: "CUSTOMER_HAS_NOT_ANSWERED",
              instruction: "You just asked the customer a question. Stay silent and wait for their answer. Only end the call after they say they need nothing else.",
            };
          } else {
            result = { ok: true, note: "Call will end after your goodbye finishes playing. Do not say anything else." };
            hangupAt.current = Date.now() + 800;
          }
          patch(entryId, { tool: { name, args, result } });
          toolLog.current.push({ name, args, result });
          return { id: fc.id, name, response: { result } };
        }
        try {
          const r = await fetch("/api/tools", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, args }),
          });
          const data = await r.json();
          result = (data.result ?? data) as Record<string, unknown>;
        } catch {
          result = { error: "TOOL_UNAVAILABLE", instruction: "Apologise and say the order system is not responding right now." };
        }
        patch(entryId, { tool: { name, args, result } });
        toolLog.current.push({ name, args, result });
        return { id: fc.id, name, response: { result } };
      }),
    );

    pendingTools.current = Math.max(0, pendingTools.current - calls.length);
    const toSend = responses.filter((r) => !(r.id && cancelledCalls.current.has(r.id)));
    if (toSend.length && session.current) {
      session.current.sendToolResponse({ functionResponses: toSend });
    }
  };

  // ---------- server messages ----------
  const onMessage = (msg: LiveServerMessage) => {
    if (msg.goAway) {
      // Server warns it will close the session soon (e.g. time or quota limit).
      console.warn("[aria] server goAway", msg.goAway);
      setError("The AI service is about to end this session. Please wrap up or start a new call.");
    }
    if (msg.toolCall) {
      // Speech after the tool result is a new reply, so start a fresh transcript line.
      currentAgent.current = null;
      currentCustomer.current = null;
      void runTools(msg);
      return;
    }
    if (msg.toolCallCancellation?.ids) {
      msg.toolCallCancellation.ids.forEach((id) => cancelledCalls.current.add(id));
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.interrupted) {
      // Customer started talking over Aria: silence her immediately.
      if (player.current?.playing) bargeIns.current++;
      player.current?.stop();
      if (currentAgent.current) patch(currentAgent.current, { interrupted: true });
      currentAgent.current = null;
    }

    if (sc.inputTranscription?.text) {
      lastCustomerTextAt.current = Date.now();
      if (currentCustomer.current === null) {
        currentCustomer.current = addEntry({ role: "customer", text: sc.inputTranscription.text });
      } else {
        appendTo(currentCustomer.current, sc.inputTranscription.text);
      }
      awaitingReply.current = true;
      currentAgent.current = null;
    }

    for (const part of sc.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio")) {
        if (awaitingReply.current) {
          awaitingReply.current = false;
          if (lastVoiceAt.current > 0) {
            const ms = Date.now() - lastVoiceAt.current;
            // Ignore greetings / tool round trips skewing the number beyond a sane bound.
            if (ms > 0 && ms < 15000) {
              latenciesRef.current = [...latenciesRef.current, ms];
              setLatencies(latenciesRef.current);
            }
          }
        }
        lastAudioAt.current = Date.now();
        lastAgentActivityAt.current = Date.now();
        player.current?.enqueue(part.inlineData.data);
      }
    }

    if (sc.outputTranscription?.text) {
      currentCustomer.current = null; // the customer's turn is over
      if (currentAgent.current === null) {
        currentAgent.current = addEntry({ role: "agent", text: sc.outputTranscription.text });
      } else {
        appendTo(currentAgent.current, sc.outputTranscription.text);
      }
    }

    if (sc.turnComplete) {
      if (pendingTools.current === 0) awaitingReply.current = false;
      currentAgent.current = null;
      currentCustomer.current = null;
    }
  };

  // ---------- teardown + summary ----------
  const finish = useCallback(async (endedBy: "customer" | "agent" | "connection", reason?: string) => {
    if (ending.current) return;
    ending.current = true;
    live.current = false;
    if (ticker.current) clearInterval(ticker.current);
    mic.current?.stop();
    player.current?.close();
    try {
      session.current?.close();
    } catch {}
    session.current = null;
    setMicLevel(0);
    setAgentLevel(0);
    setState("ended");
    if (reason) setError(reason);

    const transcript = entriesRef.current
      .filter((e) => e.role !== "tool" && /[\p{L}\p{N}]/u.test(e.text))
      .map((e) => ({ role: e.role, text: e.text.trim() }));
    const lat = latenciesRef.current;
    const meta: CallOutcome["meta"] = {
      call_id: `CALL-${new Date(startedAt.current).toISOString().replace(/\D/g, "").slice(2, 14)}`,
      started_at: new Date(startedAt.current).toISOString(),
      duration_seconds: Math.round((Date.now() - startedAt.current) / 1000),
      customer_turns: transcript.filter((t) => t.role === "customer").length,
      agent_turns: transcript.filter((t) => t.role === "agent").length,
      tools_called: toolLog.current.map((t) => t.name),
      avg_response_latency_ms: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null,
      barge_ins: bargeIns.current,
      ended_by: endedBy,
    };

    setSummarising(true);
    try {
      const r = await fetch("/api/summary", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, tools: toolLog.current }),
      });
      const data = await r.json();
      setOutcome({ summary: data.summary ?? null, source: data.source, error: data.error, meta });
    } catch {
      setOutcome({ summary: null, error: "Could not generate the summary.", meta });
    } finally {
      setSummarising(false);
    }
  }, []);

  // ---------- start ----------
  const start = useCallback(async () => {
    if (live.current) return;
    setError(null);
    setOutcome(null);
    setLatencies([]);
    latenciesRef.current = [];
    commit([]);
    toolLog.current = [];
    nextId.current = 1;
    currentAgent.current = null;
    currentCustomer.current = null;
    awaitingReply.current = false;
    pendingTools.current = 0;
    cancelledCalls.current.clear();
    bargeIns.current = 0;
    lastVoiceAt.current = 0;
    hangupAt.current = null;
    greetingDone.current = false;
    lastCustomerTextAt.current = 0;
    lastAgentActivityAt.current = 0;
    nudgedFor.current = 0;
    nudgedAt.current = 0;
    stuckShown.current = false;
    greetingStartedAt.current = Date.now();
    lastAudioAt.current = 0;
    ending.current = false;
    setElapsed(0);
    setState("connecting");

    // Create the speaker inside the click handler so browsers allow audio playback.
    const p = new AudioPlayer(24000);
    player.current = p;
    await p.resume();

    try {
      // 1. Ask our server for a short-lived token (the real API key stays on the server).
      const res = await fetch("/api/session", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not start the session.");
      const { token, model, config } = data as { token: string; model: string; config: LiveConnectConfig };

      // 2. Open the microphone.
      const m = new MicStream();
      mic.current = m;
      let micReady = false;
      try {
        await m.start(
          (b64) => {
            if (micReady && live.current && greetingDone.current) {
              session.current?.sendRealtimeInput({ audio: { data: b64, mimeType: `audio/pcm;rate=${m.sampleRate}` } });
            }
          },
          (rms) => {
            setMicLevel(rms);
            if (rms > VOICE_THRESHOLD) lastVoiceAt.current = Date.now();
          },
        );
      } catch {
        throw new Error("Microphone access was blocked. Allow the microphone for this site and try again.");
      }

      // 3. Connect straight from the browser to Gemini Live over a WebSocket.
      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1beta" } });
      startedAt.current = Date.now();
      const s = await ai.live.connect({
        model,
        config,
        callbacks: {
          onopen: () => {},
          onmessage: onMessage,
          onerror: (e: ErrorEvent) => {
            console.error("[aria] live error", e);
            if (live.current) setError(`Connection problem: ${e.message || "unknown error"}. If Aria stops responding, start a new call.`);
          },
          onclose: (e: CloseEvent) => {
            console.warn("[aria] socket closed", e.code, e.reason);
            if (live.current && !ending.current) {
              void finish("connection", e.reason ? `Call disconnected: ${e.reason}` : "The call was disconnected.");
            }
          },
        },
      });
      session.current = s;
      live.current = true;
      micReady = true;
      ticker.current = setInterval(tick, 100);
      setState("listening");

      // 4. Nudge Aria to greet the customer first, like a real support line.
      awaitingReply.current = true;
      greetingStartedAt.current = Date.now();
      s.sendClientContent({
        turns: [{ role: "user", parts: [{ text: "(The customer's call has just connected. Greet them now.)" }] }],
        turnComplete: true,
      });
    } catch (e) {
      mic.current?.stop();
      player.current?.close();
      live.current = false;
      setState("error");
      setError(e instanceof Error ? e.message : "Something went wrong starting the call.");
    }
  }, [finish, tick]);

  finishRef.current = finish;

  const end = useCallback(() => {
    if (live.current) void finish("customer");
  }, [finish]);

  /** Fallback for noisy rooms or a broken mic: type a message into the same live session. */
  const sendText = useCallback((text: string) => {
    const t = text.trim();
    if (!t || !session.current || !live.current) return;
    player.current?.stop();
    currentAgent.current = null;
    currentCustomer.current = null;
    greetingDone.current = true;
    lastCustomerTextAt.current = Date.now();
    addEntry({ role: "customer", text: t, typed: true });
    awaitingReply.current = true;
    lastVoiceAt.current = Date.now();
    session.current.sendRealtimeInput({ text: t });
  }, []);

  useEffect(() => {
    return () => {
      live.current = false;
      if (ticker.current) clearInterval(ticker.current);
      mic.current?.stop();
      player.current?.close();
      try {
        session.current?.close();
      } catch {}
    };
  }, []);

  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;

  return {
    state,
    entries,
    error,
    elapsed,
    latencies,
    avgLatency,
    outcome,
    summarising,
    micLevel,
    agentLevel,
    start,
    end,
    sendText,
  };
}
