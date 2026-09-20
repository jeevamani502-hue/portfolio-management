/**
 * Settings: risk configuration, appearance, notifications, and — the sensitive
 * part — broker/data-provider credentials.
 *
 * Credential handling contract:
 *   · secrets are accepted write-only and immediately AES-256-GCM encrypted
 *   · GET never returns a secret, only which fields are populated
 *   · a connectivity test decrypts in-process, probes, and returns a verdict
 *     with no credential material in the response
 *   · the scrubSecrets middleware is a second line of defence over all of this
 */
import { Router } from 'express';
import { z } from 'zod';
import {
  asyncHandler, respond, requireAuth, validate, auditLog,
} from '../../middleware/index.js';
import { query, queryOne, queryRows } from '../../db/pool.js';
import { encryptJson, decryptJson } from '../../utils/crypto.js';
import { notFound, badRequest } from '../../utils/errors.js';
import {
  buildRegistry, invalidateUserRegistry, registryForUser,
} from '../../providers/registry.js';
import type { ProviderId, ProviderCredentials } from '../../providers/types.js';
import { DhanProvider } from '../../providers/dhan/index.js';
import { KiteProvider } from '../../providers/kite/index.js';
import { AngelOneProvider } from '../../providers/angelone/index.js';
import { NsePublicProvider } from '../../providers/nsepublic/index.js';
import { GrowwProvider } from '../../providers/groww/index.js';
import { EodhdProvider } from '../../providers/fundamentals/eodhd.js';
import { RssNewsProvider } from '../../providers/news/rss.js';
import { env } from '../../config/env.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

// ── user settings ───────────────────────────────────────────────────────────

interface SettingsRow {
  capital: number;
  max_risk_per_trade_pct: number;
  max_daily_loss_pct: number;
  max_open_positions: number;
  default_timeframe: string;
  theme: string;
  notify_browser: boolean;
  notify_email: boolean;
  notify_telegram: boolean;
  telegram_chat_id: string | null;
}

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    let row = await queryOne<SettingsRow>(
      `SELECT capital, max_risk_per_trade_pct, max_daily_loss_pct, max_open_positions,
              default_timeframe, theme, notify_browser, notify_email, notify_telegram,
              telegram_chat_id
         FROM user_settings WHERE user_id = $1`,
      [req.user!.id],
    );

    if (!row) {
      await query(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [
        req.user!.id,
      ]);
      row = await queryOne<SettingsRow>(
        `SELECT capital, max_risk_per_trade_pct, max_daily_loss_pct, max_open_positions,
                default_timeframe, theme, notify_browser, notify_email, notify_telegram,
                telegram_chat_id
           FROM user_settings WHERE user_id = $1`,
        [req.user!.id],
      );
    }

    respond(res, {
      risk: {
        capital: row!.capital,
        maxRiskPerTradePct: row!.max_risk_per_trade_pct,
        maxDailyLossPct: row!.max_daily_loss_pct,
        maxOpenPositions: row!.max_open_positions,
        maxRiskPerTradeAmount: (row!.capital * row!.max_risk_per_trade_pct) / 100,
        maxDailyLossAmount: (row!.capital * row!.max_daily_loss_pct) / 100,
      },
      preferences: {
        defaultTimeframe: row!.default_timeframe,
        theme: row!.theme,
      },
      notifications: {
        browser: row!.notify_browser,
        email: row!.notify_email,
        telegram: row!.notify_telegram,
        telegramChatId: row!.telegram_chat_id,
      },
    });
  }),
);

const patchSettingsSchema = z.object({
  capital: z.number().positive().max(1e12).optional(),
  maxRiskPerTradePct: z.number().positive().max(100).optional(),
  maxDailyLossPct: z.number().positive().max(100).optional(),
  maxOpenPositions: z.number().int().positive().max(200).optional(),
  defaultTimeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']).optional(),
  theme: z.enum(['dark', 'light', 'system']).optional(),
  notifyBrowser: z.boolean().optional(),
  notifyEmail: z.boolean().optional(),
  notifyTelegram: z.boolean().optional(),
  telegramChatId: z.string().max(64).nullable().optional(),
});

settingsRouter.patch(
  '/',
  validate(patchSettingsSchema),
  auditLog('settings.update', 'user_settings'),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof patchSettingsSchema>;
    await query(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [req.user!.id],
    );
    await query(
      `UPDATE user_settings SET
         capital = COALESCE($2, capital),
         max_risk_per_trade_pct = COALESCE($3, max_risk_per_trade_pct),
         max_daily_loss_pct = COALESCE($4, max_daily_loss_pct),
         max_open_positions = COALESCE($5, max_open_positions),
         default_timeframe = COALESCE($6, default_timeframe),
         theme = COALESCE($7, theme),
         notify_browser = COALESCE($8, notify_browser),
         notify_email = COALESCE($9, notify_email),
         notify_telegram = COALESCE($10, notify_telegram),
         telegram_chat_id = COALESCE($11, telegram_chat_id)
       WHERE user_id = $1`,
      [
        req.user!.id,
        b.capital ?? null, b.maxRiskPerTradePct ?? null, b.maxDailyLossPct ?? null,
        b.maxOpenPositions ?? null, b.defaultTimeframe ?? null, b.theme ?? null,
        b.notifyBrowser ?? null, b.notifyEmail ?? null, b.notifyTelegram ?? null,
        b.telegramChatId ?? null,
      ],
    );
    respond(res, { updated: true });
  }),
);

// ── providers ───────────────────────────────────────────────────────────────

/** Instantiate a bare provider purely to read its manifest. */
function manifestFor(id: ProviderId) {
  switch (id) {
    case 'groww': return new GrowwProvider().manifest;
    case 'dhan': return new DhanProvider().manifest;
    case 'kite': return new KiteProvider().manifest;
    case 'angelone': return new AngelOneProvider().manifest;
    case 'nsepublic': return new NsePublicProvider().manifest;
    case 'eodhd': return new EodhdProvider({}).manifest;
    case 'rss': return new RssNewsProvider({}).manifest;
    default: return null;
  }
}

const SUPPORTED: ProviderId[] = ['groww', 'dhan', 'angelone', 'kite', 'nsepublic', 'eodhd', 'rss'];

/** Catalogue of providers the user can configure, with their credential fields. */
settingsRouter.get(
  '/providers/catalogue',
  asyncHandler(async (_req, res) => {
    respond(
      res,
      SUPPORTED.map((id) => {
        const m = manifestFor(id);
        return m
          ? {
              id: m.id,
              displayName: m.displayName,
              docsUrl: m.docsUrl,
              authModel: m.authModel,
              capabilities: m.capabilities,
              credentialFields: m.credentialFields,
              notes: m.notes,
              requiresOptIn: m.requiresOptIn ?? false,
            }
          : null;
      }).filter(Boolean),
      {
        note:
          'Credentials are stored encrypted on the server and are never returned by the API or sent to the browser. ' +
          'Each user connects their own broker account; the platform does not redistribute a shared feed.',
      },
    );
  }),
);

/** Configured providers — never includes secret values. */
settingsRouter.get(
  '/providers',
  asyncHandler(async (req, res) => {
    const rows = await queryRows<{
      id: string; provider: ProviderId; label: string | null; is_enabled: boolean;
      priority: number; health_status: string; last_ok_at: Date | null;
      last_error: string | null; credentials_enc: string | null; updated_at: Date;
    }>(
      `SELECT id, provider, label, is_enabled, priority, health_status, last_ok_at,
              last_error, credentials_enc, updated_at
         FROM api_providers WHERE user_id = $1 ORDER BY priority, provider`,
      [req.user!.id],
    );

    const data = rows.map((r) => {
      const manifest = manifestFor(r.provider);
      // Report only WHICH fields are populated. Secret fields become `true`,
      // never a value and not even a partial mask — a mask is still a leak of
      // entropy, and the UI only needs to know a key is present.
      let configuredFields: Record<string, string | boolean | null> = {};
      let decryptError: string | null = null;
      if (r.credentials_enc) {
        try {
          const creds = decryptJson<ProviderCredentials>(r.credentials_enc);
          configuredFields = Object.fromEntries(
            Object.entries(creds).map(([k, v]) => {
              const field = manifest?.credentialFields.find((f) => f.key === k);
              return [k, field?.secret !== false ? Boolean(v) : (v ?? null)];
            }),
          );
        } catch {
          decryptError =
            'Stored credentials could not be decrypted. This usually means CREDENTIAL_ENC_KEY changed — re-enter them.';
        }
      }

      return {
        id: r.id,
        provider: r.provider,
        displayName: manifest?.displayName ?? r.provider,
        label: r.label,
        isEnabled: r.is_enabled,
        priority: r.priority,
        health: {
          status: r.health_status,
          lastOkAt: r.last_ok_at?.toISOString() ?? null,
          lastError: r.last_error,
        },
        configuredFields,
        decryptError,
        updatedAt: r.updated_at.toISOString(),
      };
    });

    respond(res, data, {
      envFallback: {
        primary: env.PRIMARY_PROVIDER,
        failover: env.FAILOVER_PROVIDERS,
        note:
          'When no per-user credentials are stored, the server falls back to credentials supplied via environment variables.',
      },
    });
  }),
);

const upsertProviderSchema = z.object({
  provider: z.enum(['groww', 'dhan', 'angelone', 'kite', 'upstox', 'fyers', 'nsepublic', 'eodhd', 'rss']),
  label: z.string().max(80).optional(),
  credentials: z.record(z.string().max(4000)),
  isEnabled: z.boolean().default(true),
  priority: z.number().int().min(0).max(999).default(100),
});

settingsRouter.post(
  '/providers',
  validate(upsertProviderSchema),
  auditLog('settings.provider.upsert', 'api_providers'),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof upsertProviderSchema>;
    const manifest = manifestFor(b.provider as ProviderId);

    if (manifest) {
      const missing = manifest.credentialFields
        .filter((f) => f.required && !b.credentials[f.key]?.trim())
        .map((f) => f.label);
      if (missing.length > 0) {
        throw badRequest(`Missing required credential field(s): ${missing.join(', ')}`);
      }
    }

    // Merge with any existing credentials so a partial update does not wipe
    // fields the user did not resend.
    const existing = await queryOne<{ credentials_enc: string | null }>(
      `SELECT credentials_enc FROM api_providers WHERE user_id = $1 AND provider = $2`,
      [req.user!.id, b.provider],
    );

    let merged: ProviderCredentials = {};
    if (existing?.credentials_enc) {
      try {
        merged = decryptJson<ProviderCredentials>(existing.credentials_enc);
      } catch {
        merged = {};
      }
    }
    for (const [k, v] of Object.entries(b.credentials)) {
      if (v.trim()) merged[k] = v.trim();
    }

    const row = await queryOne<{ id: string }>(
      `INSERT INTO api_providers (user_id, provider, label, credentials_enc, is_enabled, priority, capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, provider) DO UPDATE SET
         label = COALESCE(EXCLUDED.label, api_providers.label),
         credentials_enc = EXCLUDED.credentials_enc,
         is_enabled = EXCLUDED.is_enabled,
         priority = EXCLUDED.priority,
         capabilities = EXCLUDED.capabilities,
         updated_at = now()
       RETURNING id`,
      [
        req.user!.id, b.provider, b.label ?? null, encryptJson(merged),
        b.isEnabled, b.priority, manifest?.capabilities ?? [],
      ],
    );

    invalidateUserRegistry(req.user!.id);

    respond(res, {
      id: row!.id,
      provider: b.provider,
      saved: true,
      storedFields: Object.keys(merged),
      note: 'Credentials were encrypted before storage and are not returned by any endpoint.',
    }, {}, 201);
  }),
);

settingsRouter.delete(
  '/providers/:provider',
  validate(z.object({ provider: z.string().max(40) }), 'params'),
  auditLog('settings.provider.delete', 'api_providers'),
  asyncHandler(async (req, res) => {
    const { provider } = req.params as unknown as { provider: string };
    const result = await query(
      `DELETE FROM api_providers WHERE user_id = $1 AND provider = $2`,
      [req.user!.id, provider],
    );
    if (result.rowCount === 0) throw notFound('Provider configuration not found');
    invalidateUserRegistry(req.user!.id);
    respond(res, { deleted: true });
  }),
);

/** Connectivity probe. Decrypts in-process; returns a verdict, never a secret. */
settingsRouter.post(
  '/providers/:provider/test',
  validate(z.object({ provider: z.string().max(40) }), 'params'),
  auditLog('settings.provider.test', 'api_providers'),
  asyncHandler(async (req, res) => {
    const { provider } = req.params as unknown as { provider: ProviderId };

    const row = await queryOne<{ credentials_enc: string | null }>(
      `SELECT credentials_enc FROM api_providers WHERE user_id = $1 AND provider = $2`,
      [req.user!.id, provider],
    );

    let creds: ProviderCredentials = {};
    if (row?.credentials_enc) {
      try {
        creds = decryptJson<ProviderCredentials>(row.credentials_enc);
      } catch {
        throw badRequest('Stored credentials could not be decrypted. Re-enter them.');
      }
    }

    const registry = buildRegistry({ [provider]: creds });
    const p = registry.get(provider);
    if (!p) throw badRequest(`Provider "${provider}" is not supported`);

    const probe = await p.healthCheck();

    await query(
      `UPDATE api_providers
          SET health_status = $3,
              last_ok_at = CASE WHEN $4 THEN now() ELSE last_ok_at END,
              last_error = CASE WHEN $4 THEN NULL ELSE $5 END,
              last_error_at = CASE WHEN $4 THEN last_error_at ELSE now() END
        WHERE user_id = $1 AND provider = $2`,
      [req.user!.id, provider, probe.ok ? 'healthy' : 'down', probe.ok, probe.detail ?? null],
    );

    respond(res, {
      provider,
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      detail: probe.detail ?? null,
      capabilities: p.manifest.capabilities,
      configured: p.isConfigured(),
    });
  }),
);

/** Live health across every configured provider — drives the feed indicator. */
settingsRouter.get(
  '/providers/health',
  asyncHandler(async (req, res) => {
    const registry = await registryForUser(req.user!.id);
    respond(res, await registry.probeAll());
  }),
);

/** Recent data-quality events, so feed problems are visible rather than silent. */
settingsRouter.get(
  '/data-quality',
  asyncHandler(async (_req, res) => {
    const rows = await queryRows<{
      kind: string; provider: string | null; capability: string | null;
      symbol: string | null; detail: Record<string, unknown>; occurred_at: Date;
    }>(
      `SELECT kind, provider, capability, symbol, detail, occurred_at
         FROM data_quality_events ORDER BY occurred_at DESC LIMIT 100`,
    );
    respond(res, rows.map((r) => ({
      kind: r.kind,
      provider: r.provider,
      capability: r.capability,
      symbol: r.symbol,
      detail: r.detail,
      occurredAt: r.occurred_at.toISOString(),
    })), {
      note: 'Every stale read, provider failure and rejected tick is recorded here so data problems are auditable.',
    });
  }),
);
