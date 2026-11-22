import type { SlackSenderProfile } from './inbound.js';

/** What `users.info` says about a member, beyond the sender profile of a turn. */
export interface SlackMemberProfile extends SlackSenderProfile {
  /** An app or bot user (or Slackbot): never a voter, never a participant. */
  readonly isBot?: boolean;
  /** Display name, else real name, else handle. */
  readonly displayName?: string;
}

/** The slice of a `users.info` answer read here. */
export interface SlackUsersInfoAnswer {
  user?: {
    is_bot?: boolean;
    locale?: string;
    name?: string;
    real_name?: string;
    profile?: { email?: string; display_name?: string; real_name?: string };
  };
}

export interface SlackProfileCacheDeps {
  /** `users.info` (bot scope `users:read`; `users:read.email` for the address). */
  lookup: (userId: string) => Promise<SlackUsersInfoAnswer>;
  locale: (raw: string | undefined) => string | undefined;
  log: (message: string, context?: Record<string, unknown>) => void;
  now?: () => number;
}

/** A known member keeps its profile for an hour, a failed lookup is retried after a minute, and a slow Slack never holds a turn longer than the timeout. */
const PROFILE_TTL_MS = 60 * 60 * 1000;
const PROFILE_FAILURE_TTL_MS = 60 * 1000;
const PROFILE_TIMEOUT_MS = 1_500;
const PROFILE_CACHE_MAX = 2_000;

/** Slack's own system user posts tombstones and notices; it is no person. */
export const SLACKBOT_USER_ID = 'USLACKBOT';

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** A `users.info` answer as a member profile. */
export function memberProfileOf(
  userId: string,
  answer: SlackUsersInfoAnswer,
  locale: (raw: string | undefined) => string | undefined,
): SlackMemberProfile {
  const user = answer.user;
  const email = user?.profile?.email?.trim().toLowerCase();
  const language = locale(user?.locale);
  const displayName =
    nonEmpty(user?.profile?.display_name) ?? nonEmpty(user?.profile?.real_name) ?? nonEmpty(user?.real_name) ?? nonEmpty(user?.name);
  const isBot = user?.is_bot === true || userId === SLACKBOT_USER_ID;
  return {
    ...(email ? { email } : {}),
    ...(language ? { locale: language } : {}),
    ...(displayName ? { displayName } : {}),
    ...(isBot ? { isBot: true } : {}),
  };
}

/**
 * Member profiles from `users.info`, cached. Never throws: an unknown profile
 * is `{}` (no e-mail, German notices, and counted as a person, except for
 * Slackbot, whose id is known).
 */
export class SlackProfileCache {
  private readonly profiles = new Map<string, { profile: SlackMemberProfile; expiresAt: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: SlackProfileCacheDeps) {
    this.now = deps.now ?? Date.now;
  }

  async get(userId: string): Promise<SlackMemberProfile> {
    const cached = this.profiles.get(userId);
    if (cached && cached.expiresAt > this.now()) return cached.profile;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('users.info timed out')), PROFILE_TIMEOUT_MS);
        timer.unref?.();
      });
      const answer = await Promise.race([this.deps.lookup(userId), timeout]);
      const profile = memberProfileOf(userId, answer, this.deps.locale);
      this.remember(userId, profile, PROFILE_TTL_MS);
      return profile;
    } catch (err) {
      this.deps.log('Slack sender profile unavailable', { error: err instanceof Error ? err.message : String(err) });
      const profile: SlackMemberProfile = userId === SLACKBOT_USER_ID ? { isBot: true } : {};
      this.remember(userId, profile, PROFILE_FAILURE_TTL_MS);
      return profile;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private remember(userId: string, profile: SlackMemberProfile, ttlMs: number): void {
    if (this.profiles.size >= PROFILE_CACHE_MAX) this.profiles.clear();
    this.profiles.set(userId, { profile, expiresAt: this.now() + ttlMs });
  }
}
