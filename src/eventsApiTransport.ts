import { createHmac, timingSafeEqual } from 'node:crypto';

import express, { type Request, type Response, type Router } from 'express';

import type { SlackEnvelopeBody } from './inbound.js';
import type { SlackChannel } from './slackChannel.js';
import { errMessage } from './slackChannel.js';
import type { LogSink } from './logger.js';
import { patchState, type ChannelState } from './state.js';

export interface EventsApiRouterDeps {
  /** Slack app **Signing Secret** (Basic Information → App Credentials). */
  signingSecret: string;
  channel: SlackChannel;
  log: LogSink;
  state: ChannelState;
}

/** Slack rejects/ignores requests older than 5 minutes — same window we use to
 *  drop replays. */
const REPLAY_WINDOW_S = 300;

/** Express request augmented with the raw body bytes captured for HMAC. */
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Events API transport — the production-recommended path. Slack POSTs signed
 * event deliveries to a public endpoint (`<public_base_url>/api/slack/events`).
 * The router verifies the `X-Slack-Signature` HMAC over the raw body, answers
 * the one-time `url_verification` challenge, then ACKs every delivery within
 * Slack's 3-second budget and dispatches message/app_mention events
 * asynchronously into {@link SlackChannel.ingest} (orchestrator turns far exceed
 * 3s, so we never block the response on them).
 */
export function createEventsApiRouter(deps: EventsApiRouterDeps): Router {
  const router = express.Router();

  // Capture the raw bytes for signature verification while still parsing JSON.
  router.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as RawBodyRequest).rawBody = buf;
      },
    }),
  );

  router.post('/events', (req: RawBodyRequest, res: Response) => {
    const verdict = verifySignature(req, deps.signingSecret);
    if (verdict !== 'ok') {
      // 400 for stale/malformed (no retry value), 401 for a bad signature.
      const code = verdict === 'stale' ? 400 : 401;
      res.status(code).json({ ok: false, error: verdict });
      return;
    }

    const body = (req.body ?? {}) as SlackEnvelopeBody & { challenge?: string };

    // One-time URL verification handshake — echo the challenge back.
    if (body.type === 'url_verification' && typeof body.challenge === 'string') {
      patchState(deps.state, { urlVerified: true });
      deps.log('info', 'Slack Events API url_verification handshake passed');
      res.json({ challenge: body.challenge });
      return;
    }

    if (body.type !== 'event_callback' || !body.event) {
      // Ack anything else (rate-limit notices, unsubscribed types) so Slack
      // does not retry.
      res.json({ ok: true });
      return;
    }

    // Ack FIRST (within Slack's 3s budget), then process asynchronously.
    res.json({ ok: true });
    if (!deps.state.urlVerified) patchState(deps.state, { urlVerified: true });

    const event = body.event;
    if (event.type !== 'message' && event.type !== 'app_mention') return;
    void deps.channel.ingest(event, body.team_id).catch((err: unknown) => {
      deps.log('error', 'Slack Events API ingest failed', { error: errMessage(err) });
    });
  });

  return router;
}

type SignatureVerdict = 'ok' | 'missing' | 'stale' | 'bad';

/**
 * Verify Slack's request signature: `v0=HMAC_SHA256(signingSecret, "v0:<ts>:<rawBody>")`
 * compared in constant time, with a ±5-minute replay window on the timestamp.
 */
function verifySignature(req: RawBodyRequest, signingSecret: string): SignatureVerdict {
  const ts = req.header('x-slack-request-timestamp');
  const sig = req.header('x-slack-signature');
  const raw = req.rawBody;
  if (!ts || !sig || !raw) return 'missing';

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return 'missing';
  if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_S) return 'stale';

  const hmac = createHmac('sha256', signingSecret);
  hmac.update(`v0:${ts}:`);
  hmac.update(raw);
  const expected = `v0=${hmac.digest('hex')}`;
  return timingSafeEqualStr(expected, sig) ? 'ok' : 'bad';
}

/** Length-checked constant-time string compare. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
