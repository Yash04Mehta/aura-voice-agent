# Aria — AI Voice Support Agent for Aura Skincare

A browser-based voice customer-support agent for a fictional D2C skincare brand. Click **Start Call**, talk to **Aria** through your microphone, and she answers out loud: tracking orders, explaining policies, cancelling eligible orders and politely refusing what policy doesn't allow. When the call ends you get a full transcript and a structured JSON outcome.

- **Live demo:** `https://aura-voice-agent-ruddy.vercel.app/`
- **Demo video:** `<your video link>`

**Approach in brief:** I used Google's Gemini Live API, a single speech-to-speech model, so audio streams directly between the browser and the model with no separate STT and TTS hops, which keeps replies fast and lets the customer interrupt naturally. A small Next.js backend holds the API key, mints short-lived session tokens, and owns the order data and policy rules. Aria never decides on her own whether a return or cancellation is allowed: she calls a tool, and deterministic code returns the verdict she must follow.

---

## Features

| Requirement | How it's handled |
|---|---|
| Natural voice conversation | Gemini Live native-audio model, streamed both ways over a WebSocket. Server-side voice activity detection with a 500 ms end-of-turn pause. |
| Indian persona | Aria is prompted to speak warm Indian English and mirror Hindi/Hinglish if the customer uses it. |
| Brand knowledge & guardrails | Policies live in the system prompt. Every cancel/return/damage request is checked by `check_policy_eligibility`, which returns an explicit `eligible: true/false` plus a reason. |
| Order lookup tool | `get_order_details(order_id)` plus `check_policy_eligibility`, `cancel_order`, `create_support_ticket` and `end_call` (Aria hangs up herself after saying goodbye). |
| Graceful degradation | Missing ID → asks for it. Unknown ID → `ORDER_NOT_FOUND` with an instruction not to guess. Spoken IDs like "order one zero one" or "ek shunya teen" are normalised to `ORD-101` / `ORD-103`. Unclear audio → asks to repeat. Out-of-scope → polite redirect. |
| Post-call summary | Transcript plus JSON outcome (intent, order ID, resolution status, policy applied, actions, sentiment, follow-up, summary) from a schema-constrained Gemini call, with a rule-based fallback if that call fails. |
| Testing UI | Start / End Call, live Listening / Thinking / Speaking indicator, test-orders panel, scenario shortcuts, live transcript, copy/download for JSON and transcript. |
| Extras | Barge-in (interrupting Aria stops her instantly), Hinglish, 5 tools, response-latency meter, typed-message fallback for a bad mic. |

---

## Architecture

```
 Browser (Next.js page)                                   Vercel (Next.js API routes)
 ─────────────────────────                                ───────────────────────────
 Start Call ──────────────── POST /api/session ─────────► mints 1-use ephemeral token
                                                          (model + prompt + tools locked in)
             ◄──────────────── token ────────────────────

 Mic → AudioWorklet → 16-bit PCM ─┐
                                  │  WebSocket (direct, low latency)
                                  ▼
                        ┌──────────────────────┐
                        │  Gemini Live model   │  hears audio, decides to speak
                        │  (speech-to-speech)  │  or to call a tool
                        └──────────────────────┘
                                  │ audio 24 kHz + transcripts + toolCall
 Speaker ◄─ gapless player ◄──────┤
                                  │ toolCall
 run tool ───────────────── POST /api/tools ────────────► orders.ts: mock DB + policy engine
          ◄──────────────── verdict JSON ────────────────
 sendToolResponse → model speaks the answer

 End Call ───────────────── POST /api/summary ──────────► Gemini Flash-Lite, JSON schema
          ◄──────────────── structured outcome ──────────  (rule-based fallback)
```

### How the voice pipeline works

1. **Session.** `/api/session` uses the real API key (server-only) to create an ephemeral token that is valid once, must be used within 60 seconds, and has the model, system prompt and tools locked into it.
2. **Capture.** The mic stream (with echo cancellation and noise suppression) goes through an `AudioWorklet` (`public/mic-processor.js`) that converts samples to 16-bit PCM and sends ~100 ms chunks over the WebSocket.
3. **Turn-taking.** Gemini's server-side voice activity detection decides when the customer has finished speaking. The mic is held muted only while the opening greeting plays: the browser's echo canceller needs a moment to adapt, and without this Aria "heard" her own greeting through laptop speakers and interrupted herself. Start-of-speech sensitivity is set to LOW for the same reason. If the customer talks while Aria is speaking, the server sends `interrupted` and the player drops all queued audio immediately (barge-in).
4. **Playback.** Aria's 24 kHz PCM chunks are scheduled back-to-back on a Web Audio clock so there are no gaps or clicks.
5. **Transcripts.** Input and output transcription are enabled, which builds the live transcript and feeds the summary.
6. **State indicator.** *Speaking* while audio is playing, *Thinking* while a tool is running or after the customer stops talking and before the reply arrives, otherwise *Listening*.

### How the agent decides to use a tool

The model sees five function declarations with descriptions saying when to use each, and the prompt adds hard rules: never state order details from memory; always check eligibility before agreeing to a cancel/return/damage request; only cancel after a positive verdict **and** explicit customer confirmation. When the model emits a `toolCall`, the browser forwards it to `/api/tools` (except `end_call`, which the browser handles itself: it refuses to hang up if Aria's last sentence was a question the customer hasn't answered, and otherwise ends the call once her goodbye finishes playing), sends the result back with `sendToolResponse`, and the model turns it into speech. Tools are declared `BLOCKING`, so Aria waits for the real data instead of improvising.

### How the guardrails work (three layers)

1. **Scope in the prompt.** Aria only helps with Aura Skincare; anything else gets a polite redirect. Unknown brand facts get "I don't have that information" plus an offer to raise a ticket.
2. **Policy in code, not in the model.** `lib/orders.ts` computes eligibility deterministically (7-day unopened return window, 48-hour damage window, cancel only while Processing). The tool result includes the reason and an alternative ("you can refuse delivery at the doorstep"), so the model explains the decision instead of making it.
3. **Locked configuration.** The prompt and tools are baked into the ephemeral token, so a tampered client can't swap them out.

---

## Project structure

```
app/
  page.tsx                 → renders the call console
  api/session/route.ts     → ephemeral token for Gemini Live
  api/tools/route.ts       → executes tool calls
  api/summary/route.ts     → post-call JSON outcome
components/CallConsole.tsx → the whole UI
lib/
  agent.ts                 → persona, brand knowledge, guardrails, tool schemas, live config
  orders.ts                → mock order DB + policy engine + ID normalisation
  useVoiceAgent.ts         → session, transcript, tools, state machine
  audio.ts                 → mic capture and gapless playback
  rate-limit.ts            → protects the demo's free quota
public/mic-processor.js    → AudioWorklet for PCM conversion
scripts/test-tools.ts      → 20 checks on the policy engine
```

---

## Running locally

Requirements: Node.js 20+ and a free Gemini API key from https://aistudio.google.com/apikey.

```bash
npm install
cp .env.example .env.local      # then paste your key into GEMINI_API_KEY
npm run dev                     # open http://localhost:3000
npm test                        # policy engine checks
```

Use Chrome or Edge, allow the microphone, and preferably wear headphones.

### Deploying to Vercel

1. Push this repo to GitHub.
2. Import it at vercel.com/new (Next.js is detected automatically).
3. Add the environment variable `GEMINI_API_KEY`.
4. Deploy. HTTPS is automatic, which browsers require for microphone access.

---

## Design decisions & trade-offs

- **Speech-to-speech instead of STT → LLM → TTS.** A chained pipeline adds a network hop and buffering at each stage; one realtime model removes them and supports interruptions natively. The trade-off is less control over the exact voice (no dedicated Indian TTS voice), so the accent comes from the prompt.
- **Browser connects to Gemini directly.** Proxying audio through my own server would add latency and need a long-lived WebSocket server, which serverless hosting doesn't provide. Ephemeral tokens make the direct connection safe.
- **Tools run on the server.** The browser only relays the call. Order data and policy logic stay where a real backend would keep them.
- **Rule-based summary fallback.** Built from the tool log, so the evaluator always gets a structured outcome even if the summary model is rate-limited.

---

## Tell us how you think

### 1. Why did you choose this architecture and stack?

The thing that makes a voice agent feel human is response speed and being able to interrupt it. A classic pipeline (speech-to-text, then an LLM, then text-to-speech) adds a delay at every step, and barge-in has to be built by hand. Gemini Live is a single speech-to-speech model that streams audio both ways, has voice activity detection and interruption built in, and supports function calling during the conversation. It also has a free tier, which mattered because I had no API credits.

I chose Next.js because I work mostly in React and it gives me the frontend and small backend routes in one project that deploys to Vercel in a few minutes. The backend has exactly three jobs: keep the API key secret by minting short-lived tokens, own the order data and policy rules, and generate the post-call summary.

### 2. What was the most difficult part, and how did you solve it?

Making the agent follow policy reliably instead of being agreeable. LLMs tend to say yes to a persistent customer, and prompt instructions alone aren't a guarantee. I moved the decision out of the model: `check_policy_eligibility` computes eligibility in code and returns a clear verdict with a reason and an alternative, and the prompt tells Aria she must always check before agreeing and follow the verdict. Even if a customer pushes, the model has nothing to approve; it can only explain.

A close second was echo and turn-taking. On laptop speakers, Aria's greeting leaked back into the microphone before the browser's echo canceller had adapted, so she kept interrupting herself and the transcript filled with garbled "customer" lines. I fixed it by keeping the mic muted only during the greeting and lowering the start-of-speech sensitivity. The live state indicator was also tricky: The API doesn't directly say "the agent is thinking", so I derive it from three signals: whether audio is playing, whether a tool is running, and how long the mic has been quiet after the customer spoke. Barge-in needed the audio player to be able to drop its whole queue instantly when the server reports an interruption.

### 3. With one more week, what would I improve first and why?

**An automated evaluation suite for conversations.** Right now I test the policy engine with unit tests and the conversations by talking to it. With a week I'd build a set of scripted test calls (synthesised customer audio or text turns) covering every policy edge case, pushy customers, wrong IDs and out-of-scope requests, and score each transcript automatically on whether Aria followed the rules. Every prompt change could break a guardrail silently, and in customer support a wrong refund promise costs real money, so this is the safety net everything else depends on.

After that: a dedicated Indian TTS voice in a hybrid setup, identity verification before sharing order details (for example the phone number on the order), and a proper ticketing integration.

### 4. What would need to change at 1,000 conversations a day?

- **Real data and actions.** Replace the mock DB with the order management system and courier APIs, with timeouts and retries. Tools that change state (cancellations, refunds) need idempotency keys so a retried call can't cancel twice.
- **Security and identity.** Verify the caller (OTP or registered phone) before revealing order details, and add proper authentication and a shared rate limiter (for example Redis) instead of the in-memory one.
- **Telephony.** Most customers would call a phone number, so I'd add a SIP/telephony bridge (Twilio or Exotel) with a server-side relay, plus session resumption for calls longer than the session limit.
- **Observability and QA.** Store every transcript, tool call and outcome; track resolution rate, escalation rate, latency percentiles and policy violations; automatically review a sample of calls with an LLM grader and flag failures for humans.
- **Human handoff.** A live transfer to a human agent when the customer asks, is upset, or the agent fails twice, with the summary passed along so the customer doesn't repeat themselves.
- **Cost and capacity.** At ~1,000 calls of ~3 minutes, audio tokens become the main cost, so I'd monitor cost per call, move to a paid tier with higher rate limits, and cache common FAQ answers.
- **Compliance.** Call-recording consent, PII masking in stored transcripts, and data retention rules.

---

## Known limitations

- Order data is mock and read-only; cancellations return a reference but don't persist.
- The accent is prompt-driven, so it can vary between sessions.
- The rate limiter is per server instance (fine for a demo, not for production).
- Best experienced in Chrome/Edge with headphones; on laptop speakers, echo cancellation handles most cases but very loud speakers can trigger false interruptions.
