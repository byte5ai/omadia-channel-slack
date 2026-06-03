import express, { type Router } from 'express';

import type { ChannelState } from './state.js';

export interface AdminRouterDeps {
  /** Absolute path to the bundled `assets/admin-ui` directory. */
  uiAssetsPath: string;
  state: ChannelState;
  /** True during the kernel's admin-route smoke probe — return mock data. */
  smokeMode: boolean;
  /** Operator-triggered reconnect (tear down + re-open the socket). */
  onReconnect: () => Promise<void>;
}

/**
 * Express router for the Slack admin UI. Mounted by `activate()` at
 * `/api/slack-channel/admin` via `ctx.routes.register`, then surfaced as an
 * iframe by web-ui because the manifest declares `admin_ui_path`. Serves the
 * single-file status page plus a tiny JSON API the page polls.
 *
 * Response contract (host smoke-checks this): every endpoint returns
 * `{ ok: true, ... }` on success or `{ ok: false, error }` on failure.
 */
export function createAdminRouter(deps: AdminRouterDeps): Router {
  const router = express.Router();

  // Static single-file UI. `redirect: false` avoids the trailing-slash →
  // Next-rewrite → express.static 3x-redirect chain that breaks iframe loads.
  router.use(express.static(deps.uiAssetsPath, { redirect: false }));

  router.get('/api/status', (_req, res) => {
    if (deps.smokeMode) {
      res.json({
        ok: true,
        status: 'connected',
        me: { teamId: 'T000', teamName: 'Smoke Test', botUserId: 'U000', botUserName: 'omadia' },
        lastError: null,
        updatedAt: deps.state.updatedAt,
      });
      return;
    }
    const s = deps.state;
    res.json({
      ok: true,
      status: s.status,
      me: s.me,
      lastError: s.lastError,
      updatedAt: s.updatedAt,
    });
  });

  router.post('/api/reconnect', express.json(), async (_req, res) => {
    try {
      await deps.onReconnect();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message });
    }
  });

  return router;
}
