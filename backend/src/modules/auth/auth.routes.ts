/**
 * Authentication: registration, login, refresh-token rotation, logout.
 *
 * Refresh tokens are stored hashed, grouped into a "family". Presenting a
 * token that has already been rotated revokes the whole family — the standard
 * defence against refresh-token replay after theft.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { sha256, randomToken } from '../../utils/crypto.js';
import { unauthorized, conflict, badRequest } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import {
  asyncHandler, validate, respond, requireAuth, signAccessToken, rateLimit,
  auditLog, allowTokensInResponse, type AuthUser,
} from '../../middleware/index.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'bt_refresh';

/**
 * How long after rotation a superseded refresh token is still accepted as a
 * concurrent-request race rather than treated as reuse. Long enough to cover
 * a slow page load firing parallel refreshes; far too short to be useful to
 * an attacker replaying a stolen cookie.
 */
const REFRESH_RACE_GRACE_MS = 20_000;

const registerSchema = z.object({
  email: z.string().email().max(255),
  password: z
    .string()
    .min(10, 'Password must be at least 10 characters')
    .max(200)
    .refine((p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p), {
      message: 'Password must contain lower case, upper case and a digit',
    }),
  fullName: z.string().min(1).max(120).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
});

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  role: AuthUser['role'];
  is_active: boolean;
}

function refreshTtlMs(): number {
  const ttl = env.JWT_REFRESH_TTL;
  const m = /^(\d+)([smhd])$/.exec(ttl);
  if (!m) return 7 * 24 * 3600_000;
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3600_000 : 86_400_000;
  return n * mult;
}

async function issueRefreshToken(
  userId: string,
  familyId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<string> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + refreshTtlMs());
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, sha256(token), familyId, meta.userAgent ?? null, meta.ip ?? null, expiresAt],
  );
  return token;
}

function setRefreshCookie(res: Parameters<typeof respond>[0], token: string): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/api/auth',
    maxAge: refreshTtlMs(),
  });
}

async function bootstrapUserDefaults(userId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
      userId,
    ]);
    await client.query(
      `INSERT INTO portfolios (user_id, name, is_default) VALUES ($1, 'My Portfolio', TRUE)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId],
    );
    await client.query(
      `INSERT INTO watchlists (user_id, name, is_default) VALUES ($1, 'My Watchlist', TRUE)
       ON CONFLICT (user_id, name) DO NOTHING`,
      [userId],
    );
  });
}

authRouter.post(
  '/register',
  rateLimit({ bucket: 'auth-register', limit: 5, windowSeconds: 3600 }),
  allowTokensInResponse,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, fullName } = req.body as z.infer<typeof registerSchema>;

    const existing = await queryOne<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
    if (existing) throw conflict('An account with this email already exists');

    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    const user = await queryOne<UserRow>(
      `INSERT INTO users (email, password_hash, full_name)
       VALUES ($1,$2,$3)
       RETURNING id, email, password_hash, full_name, role, is_active`,
      [email, passwordHash, fullName ?? null],
    );
    if (!user) throw new Error('Failed to create user');

    await bootstrapUserDefaults(user.id);

    const authUser: AuthUser = { id: user.id, email: user.email, role: user.role };
    const refresh = await issueRefreshToken(user.id, randomUUID(), {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setRefreshCookie(res, refresh);

    logger.info({ userId: user.id }, 'User registered');
    respond(
      res,
      {
        user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
        accessToken: signAccessToken(authUser),
        expiresIn: env.JWT_ACCESS_TTL,
      },
      {},
      201,
    );
  }),
);

authRouter.post(
  '/login',
  rateLimit({ bucket: 'auth-login', limit: 10, windowSeconds: 900 }),
  allowTokensInResponse,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginSchema>;
    const user = await queryOne<UserRow>(
      `SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1`,
      [email],
    );

    // Compare against a dummy hash when the user is absent so that response
    // time does not reveal whether the email exists.
    const hash = user?.password_hash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva';
    const ok = await bcrypt.compare(password, hash);

    if (!user || !ok) throw unauthorized('Invalid email or password');
    if (!user.is_active) throw unauthorized('This account is disabled');

    await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);

    const authUser: AuthUser = { id: user.id, email: user.email, role: user.role };
    const refresh = await issueRefreshToken(user.id, randomUUID(), {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setRefreshCookie(res, refresh);

    respond(res, {
      user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role },
      accessToken: signAccessToken(authUser),
      expiresIn: env.JWT_ACCESS_TTL,
    });
  }),
);

authRouter.post(
  '/refresh',
  rateLimit({ bucket: 'auth-refresh', limit: 60, windowSeconds: 900 }),
  allowTokensInResponse,
  asyncHandler(async (req, res) => {
    const presented = (req.cookies?.[REFRESH_COOKIE] as string | undefined) ?? (req.body?.refreshToken as string | undefined);
    if (!presented) throw unauthorized('No refresh token supplied');

    const tokenHash = sha256(presented);
    const row = await queryOne<{
      id: string; user_id: string; family_id: string; expires_at: Date;
      revoked_at: Date | null; replaced_by: string | null;
      email: string; role: AuthUser['role']; is_active: boolean;
    }>(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, rt.replaced_by,
              u.email, u.role, u.is_active
         FROM refresh_tokens rt
         JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1`,
      [tokenHash],
    );

    if (!row) throw unauthorized('Refresh token not recognised');

    if (row.revoked_at) {
      const sinceRevokedMs = Date.now() - row.revoked_at.getTime();

      /*
       * Distinguish a benign race from actual token theft.
       *
       * A browser routinely fires two refreshes at once — a page load restoring
       * the session while an in-flight request gets a 401 — and the second one
       * carries the cookie the first just rotated away. Treating that as reuse
       * revokes the family and signs the user out, which is what a naive
       * rotation implementation does and why it feels flaky in real use.
       *
       * Inside the grace window, with the replacement still live, we accept it:
       * issue a fresh access token, rotate nothing, revoke nothing. The browser
       * already holds the newer cookie from the first response.
       *
       * Outside the window the detector still does its job — a token replayed
       * minutes later is not a race, and the whole family goes.
       */
      const replacementLive =
        row.replaced_by !== null &&
        (await queryOne<{ id: string }>(
          `SELECT id FROM refresh_tokens
            WHERE id = $1 AND revoked_at IS NULL AND expires_at > now()`,
          [row.replaced_by],
        )) !== null;

      if (sinceRevokedMs <= REFRESH_RACE_GRACE_MS && replacementLive) {
        logger.debug(
          { userId: row.user_id, sinceRevokedMs },
          'Concurrent refresh within the grace window — issuing an access token without rotating',
        );
        const raceUser: AuthUser = { id: row.user_id, email: row.email, role: row.role };
        return respond(res, {
          accessToken: signAccessToken(raceUser),
          expiresIn: env.JWT_ACCESS_TTL,
        });
      }

      await query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = $1 AND revoked_at IS NULL`,
        [row.family_id],
      );
      logger.warn(
        { userId: row.user_id, familyId: row.family_id, sinceRevokedMs },
        'Refresh token reuse detected outside the grace window — revoked entire token family',
      );
      throw unauthorized('Refresh token has already been used. Please sign in again.');
    }

    if (row.expires_at.getTime() < Date.now()) throw unauthorized('Refresh token expired');
    if (!row.is_active) throw unauthorized('This account is disabled');

    const next = await issueRefreshToken(row.user_id, row.family_id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    await query(
      `UPDATE refresh_tokens SET revoked_at = now(),
              replaced_by = (SELECT id FROM refresh_tokens WHERE token_hash = $2)
        WHERE id = $1`,
      [row.id, sha256(next)],
    );
    setRefreshCookie(res, next);

    const authUser: AuthUser = { id: row.user_id, email: row.email, role: row.role };
    respond(res, { accessToken: signAccessToken(authUser), expiresIn: env.JWT_ACCESS_TTL });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const presented = req.cookies?.[REFRESH_COOKIE] as string | undefined;
    if (presented) {
      await query(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
            AND revoked_at IS NULL`,
        [sha256(presented)],
      );
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    respond(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await queryOne<{
      id: string; email: string; full_name: string | null; role: string; created_at: Date;
    }>(`SELECT id, email, full_name, role, created_at FROM users WHERE id = $1`, [req.user!.id]);
    if (!user) throw unauthorized();
    respond(res, {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      createdAt: user.created_at.toISOString(),
    });
  }),
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: registerSchema.shape.password,
});

authRouter.post(
  '/password',
  requireAuth,
  rateLimit({ bucket: 'auth-password', limit: 5, windowSeconds: 3600 }),
  validate(changePasswordSchema),
  auditLog('password.change', 'user'),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const user = await queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.user!.id],
    );
    if (!user) throw unauthorized();
    if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
      throw badRequest('Current password is incorrect');
    }

    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [
      req.user!.id,
      await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS),
    ]);
    // Changing the password invalidates every existing session.
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [req.user!.id],
    );

    respond(res, { changed: true, message: 'Password updated. Other sessions have been signed out.' });
  }),
);
