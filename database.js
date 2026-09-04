const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_DATABASE_FILE = path.join(
  __dirname,
  "data",
  "brand-partnership.sqlite"
);

const DATABASE_FILE =
  process.env.SQLITE_DATABASE_PATH || DEFAULT_DATABASE_FILE;

function nowISO() {
  return new Date().toISOString();
}

function openDatabase() {
  fs.mkdirSync(path.dirname(DATABASE_FILE), {
    recursive: true,
  });

  const db = new DatabaseSync(DATABASE_FILE);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);

  initializeSchema(db);

  return db;
}

function initializeSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS creators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS creator_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      creator_id INTEGER NOT NULL,
      discord_invite_code TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'inactive', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (creator_id)
        REFERENCES creators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      UNIQUE (discord_invite_code),
      UNIQUE (guild_id, discord_invite_code)
    );

    CREATE TABLE IF NOT EXISTS discord_join_attributions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      creator_id INTEGER,
      creator_invite_id INTEGER,
      discord_invite_code TEXT,
      joined_at TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('attributed', 'unattributed', 'ambiguous')),
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (creator_id)
        REFERENCES creators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (creator_invite_id)
        REFERENCES creator_invites(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      UNIQUE (guild_id, discord_user_id),
      CHECK (
        status != 'attributed'
        OR (
          creator_id IS NOT NULL
          AND creator_invite_id IS NOT NULL
          AND discord_invite_code IS NOT NULL
        )
      )
    );

    CREATE TABLE IF NOT EXISTS partnership_conversations (
      conversation_id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL UNIQUE,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      creator_id INTEGER,
      creator_invite_id INTEGER,
      creator_invite_code TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('active', 'archived', 'missing')),
      created_at TEXT NOT NULL,
      archived_at TEXT,
      archived_by TEXT,
      migrated_from_json_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (creator_id)
        REFERENCES creators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (creator_invite_id)
        REFERENCES creator_invites(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS stripe_customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      stripe_customer_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (guild_id, discord_user_id)
    );

    CREATE TABLE IF NOT EXISTS stripe_checkout_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stripe_checkout_session_id TEXT NOT NULL UNIQUE,
      stripe_customer_id TEXT,
      conversation_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      stripe_price_id TEXT NOT NULL,
      creator_id INTEGER,
      creator_invite_id INTEGER,
      creator_invite_code TEXT,
      status TEXT NOT NULL,
      url TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id)
        REFERENCES partnership_conversations(conversation_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (creator_id)
        REFERENCES creators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (creator_invite_id)
        REFERENCES creator_invites(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS brand_subscriptions (
      stripe_subscription_id TEXT PRIMARY KEY,
      stripe_customer_id TEXT NOT NULL,
      conversation_id INTEGER,
      guild_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      plan_key TEXT,
      stripe_price_id TEXT,
      creator_id INTEGER,
      creator_invite_id INTEGER,
      creator_invite_code TEXT,
      status TEXT NOT NULL,
      current_period_start TEXT,
      current_period_end TEXT,
      cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
      canceled_at TEXT,
      latest_invoice_id TEXT,
      last_payment_status TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id)
        REFERENCES partnership_conversations(conversation_id)
        ON UPDATE CASCADE
        ON DELETE SET NULL,
      FOREIGN KEY (creator_id)
        REFERENCES creators(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (creator_invite_id)
        REFERENCES creator_invites(id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
      stripe_event_id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      livemode INTEGER NOT NULL,
      stripe_created_at TEXT,
      received_at TEXT NOT NULL,
      processed_at TEXT,
      processing_error TEXT
    );

    CREATE TABLE IF NOT EXISTS stripe_paid_confirmations (
      stripe_invoice_id TEXT PRIMARY KEY,
      stripe_subscription_id TEXT NOT NULL,
      conversation_id INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      plan_key TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
      discord_message_id TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      FOREIGN KEY (stripe_subscription_id)
        REFERENCES brand_subscriptions(stripe_subscription_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT,
      FOREIGN KEY (conversation_id)
        REFERENCES partnership_conversations(conversation_id)
        ON UPDATE CASCADE
        ON DELETE RESTRICT
    );
  `);
}

function getDatabasePath() {
  return DATABASE_FILE;
}

function getActiveCreatorInvites(db, guildId) {
  return db
    .prepare(`
      SELECT
        creator_invites.id AS creator_invite_id,
        creator_invites.creator_id,
        creator_invites.discord_invite_code,
        creator_invites.guild_id,
        creators.display_name AS creator_display_name
      FROM creator_invites
      JOIN creators
        ON creators.id = creator_invites.creator_id
      WHERE creator_invites.guild_id = ?
        AND creator_invites.status = 'active'
        AND creators.status = 'active'
    `)
    .all(guildId);
}

function getStoredAttributionForUser(db, guildId, discordUserId) {
  return db
    .prepare(`
      SELECT
        discord_join_attributions.*,
        creators.display_name AS creator_display_name
      FROM discord_join_attributions
      LEFT JOIN creators
        ON creators.id = discord_join_attributions.creator_id
      WHERE discord_join_attributions.guild_id = ?
        AND discord_join_attributions.discord_user_id = ?
        AND discord_join_attributions.status = 'attributed'
      LIMIT 1
    `)
    .get(guildId, discordUserId);
}

function recordJoinAttribution(db, attribution) {
  const timestamp = nowISO();

  const result = db.prepare(`
    INSERT OR IGNORE INTO discord_join_attributions (
      discord_user_id,
      guild_id,
      creator_id,
      creator_invite_id,
      discord_invite_code,
      joined_at,
      status,
      reason,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    attribution.discordUserId,
    attribution.guildId,
    attribution.creatorId || null,
    attribution.creatorInviteId || null,
    attribution.discordInviteCode || null,
    attribution.joinedAt || timestamp,
    attribution.status,
    attribution.reason,
    timestamp,
    timestamp
  );

  return {
    inserted: result.changes === 1,
    attribution: db
      .prepare(`
        SELECT *
        FROM discord_join_attributions
        WHERE guild_id = ?
          AND discord_user_id = ?
        LIMIT 1
      `)
      .get(attribution.guildId, attribution.discordUserId),
  };
}

function upsertPartnershipConversation(db, conversation) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT INTO partnership_conversations (
      conversation_id,
      channel_id,
      guild_id,
      discord_user_id,
      creator_id,
      creator_invite_id,
      creator_invite_code,
      status,
      created_at,
      archived_at,
      archived_by,
      migrated_from_json_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      channel_id = excluded.channel_id,
      guild_id = excluded.guild_id,
      discord_user_id = excluded.discord_user_id,
      status = excluded.status,
      archived_at = excluded.archived_at,
      archived_by = excluded.archived_by,
      updated_at = excluded.updated_at
  `).run(
    conversation.conversationId,
    conversation.channelId,
    conversation.guildId,
    conversation.discordUserId,
    conversation.creatorId || null,
    conversation.creatorInviteId || null,
    conversation.creatorInviteCode || null,
    conversation.status,
    conversation.createdAt,
    conversation.archivedAt || null,
    conversation.archivedBy || null,
    conversation.migratedFromJsonAt || null,
    timestamp
  );
}

function migrateConversationsFromJson(db, conversations, guildId) {
  const timestamp = nowISO();

  db.exec("BEGIN");

  try {
    for (const conversation of conversations) {
      upsertPartnershipConversation(db, {
        conversationId: conversation.conversationId,
        channelId: conversation.channelId,
        guildId,
        discordUserId: conversation.userId,
        creatorId: null,
        creatorInviteId: null,
        creatorInviteCode: null,
        status: conversation.status,
        createdAt: conversation.createdAt || timestamp,
        archivedAt: conversation.archivedAt || null,
        archivedBy: conversation.archivedBy || null,
        migratedFromJsonAt: timestamp,
      });
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getPartnershipConversationByChannelId(db, channelId) {
  return db
    .prepare(`
      SELECT *
      FROM partnership_conversations
      WHERE channel_id = ?
      LIMIT 1
    `)
    .get(channelId);
}

function getStripeCustomerForDiscordUser(db, guildId, discordUserId) {
  return db
    .prepare(`
      SELECT *
      FROM stripe_customers
      WHERE guild_id = ?
        AND discord_user_id = ?
      LIMIT 1
    `)
    .get(guildId, discordUserId);
}

function saveStripeCustomer(db, customer) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT OR IGNORE INTO stripe_customers (
      guild_id,
      discord_user_id,
      stripe_customer_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run(
    customer.guildId,
    customer.discordUserId,
    customer.stripeCustomerId,
    timestamp,
    timestamp
  );

  return getStripeCustomerForDiscordUser(
    db,
    customer.guildId,
    customer.discordUserId
  );
}

function upsertStripeCheckoutSession(db, session) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT INTO stripe_checkout_sessions (
      stripe_checkout_session_id,
      stripe_customer_id,
      conversation_id,
      guild_id,
      discord_user_id,
      plan_key,
      stripe_price_id,
      creator_id,
      creator_invite_id,
      creator_invite_code,
      status,
      url,
      expires_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_checkout_session_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      conversation_id = excluded.conversation_id,
      guild_id = excluded.guild_id,
      discord_user_id = excluded.discord_user_id,
      plan_key = excluded.plan_key,
      stripe_price_id = excluded.stripe_price_id,
      creator_id = excluded.creator_id,
      creator_invite_id = excluded.creator_invite_id,
      creator_invite_code = excluded.creator_invite_code,
      status = excluded.status,
      url = excluded.url,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(
    session.stripeCheckoutSessionId,
    session.stripeCustomerId || null,
    session.conversationId,
    session.guildId,
    session.discordUserId,
    session.planKey,
    session.stripePriceId,
    session.creatorId || null,
    session.creatorInviteId || null,
    session.creatorInviteCode || null,
    session.status,
    session.url || null,
    session.expiresAt || null,
    timestamp,
    timestamp
  );
}

function getStripeCheckoutSession(db, stripeCheckoutSessionId) {
  return db
    .prepare(`
      SELECT *
      FROM stripe_checkout_sessions
      WHERE stripe_checkout_session_id = ?
      LIMIT 1
    `)
    .get(stripeCheckoutSessionId);
}

function updateStripeCheckoutSessionStatus(db, session) {
  const timestamp = nowISO();

  db.prepare(`
    UPDATE stripe_checkout_sessions
    SET status = ?,
      stripe_customer_id = COALESCE(?, stripe_customer_id),
      updated_at = ?
    WHERE stripe_checkout_session_id = ?
  `).run(
    session.status,
    session.stripeCustomerId || null,
    timestamp,
    session.stripeCheckoutSessionId
  );
}

function upsertBrandSubscription(db, subscription) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT INTO brand_subscriptions (
      stripe_subscription_id,
      stripe_customer_id,
      conversation_id,
      guild_id,
      discord_user_id,
      plan_key,
      stripe_price_id,
      creator_id,
      creator_invite_id,
      creator_invite_code,
      status,
      current_period_start,
      current_period_end,
      cancel_at_period_end,
      canceled_at,
      latest_invoice_id,
      last_payment_status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(stripe_subscription_id) DO UPDATE SET
      stripe_customer_id = excluded.stripe_customer_id,
      conversation_id = COALESCE(
        excluded.conversation_id,
        brand_subscriptions.conversation_id
      ),
      guild_id = excluded.guild_id,
      discord_user_id = excluded.discord_user_id,
      plan_key = excluded.plan_key,
      stripe_price_id = excluded.stripe_price_id,
      status = excluded.status,
      current_period_start = excluded.current_period_start,
      current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end,
      canceled_at = excluded.canceled_at,
      latest_invoice_id = COALESCE(
        excluded.latest_invoice_id,
        brand_subscriptions.latest_invoice_id
      ),
      last_payment_status = COALESCE(
        excluded.last_payment_status,
        brand_subscriptions.last_payment_status
      ),
      updated_at = excluded.updated_at
  `).run(
    subscription.stripeSubscriptionId,
    subscription.stripeCustomerId,
    subscription.conversationId || null,
    subscription.guildId,
    subscription.discordUserId,
    subscription.planKey || null,
    subscription.stripePriceId || null,
    subscription.creatorId || null,
    subscription.creatorInviteId || null,
    subscription.creatorInviteCode || null,
    subscription.status,
    subscription.currentPeriodStart || null,
    subscription.currentPeriodEnd || null,
    subscription.cancelAtPeriodEnd ? 1 : 0,
    subscription.canceledAt || null,
    subscription.latestInvoiceId || null,
    subscription.lastPaymentStatus || null,
    timestamp,
    timestamp
  );
}

function updateSubscriptionInvoiceStatus(db, invoice) {
  const timestamp = nowISO();

  db.prepare(`
    UPDATE brand_subscriptions
    SET latest_invoice_id = ?,
      last_payment_status = ?,
      updated_at = ?
    WHERE stripe_subscription_id = ?
  `).run(
    invoice.latestInvoiceId,
    invoice.lastPaymentStatus,
    timestamp,
    invoice.stripeSubscriptionId
  );
}

function getBrandSubscription(db, stripeSubscriptionId) {
  return db
    .prepare(`
      SELECT *
      FROM brand_subscriptions
      WHERE stripe_subscription_id = ?
      LIMIT 1
    `)
    .get(stripeSubscriptionId);
}

function getPartnershipConversationById(db, conversationId) {
  return db
    .prepare(`
      SELECT *
      FROM partnership_conversations
      WHERE conversation_id = ?
      LIMIT 1
    `)
    .get(conversationId);
}

function claimStripePaidConfirmation(db, notification) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT OR IGNORE INTO stripe_paid_confirmations (
      stripe_invoice_id,
      stripe_subscription_id,
      conversation_id,
      channel_id,
      plan_key,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    notification.stripeInvoiceId,
    notification.stripeSubscriptionId,
    notification.conversationId,
    notification.channelId,
    notification.planKey,
    timestamp,
    timestamp
  );

  const result = db.prepare(`
    UPDATE stripe_paid_confirmations
    SET status = 'sending',
      last_error = NULL,
      updated_at = ?
    WHERE stripe_invoice_id = ?
      AND status IN ('pending', 'failed')
  `).run(timestamp, notification.stripeInvoiceId);

  const row = db
    .prepare(`
      SELECT *
      FROM stripe_paid_confirmations
      WHERE stripe_invoice_id = ?
      LIMIT 1
    `)
    .get(notification.stripeInvoiceId);

  return {
    claimed: result.changes === 1,
    notification: row,
  };
}

function markStripePaidConfirmationSent(db, notification) {
  const timestamp = nowISO();

  db.prepare(`
    UPDATE stripe_paid_confirmations
    SET status = 'sent',
      discord_message_id = ?,
      last_error = NULL,
      updated_at = ?,
      sent_at = ?
    WHERE stripe_invoice_id = ?
  `).run(
    notification.discordMessageId,
    timestamp,
    timestamp,
    notification.stripeInvoiceId
  );
}

function markStripePaidConfirmationFailed(db, notification) {
  db.prepare(`
    UPDATE stripe_paid_confirmations
    SET status = 'failed',
      last_error = ?,
      updated_at = ?
    WHERE stripe_invoice_id = ?
  `).run(
    String(notification.error.message || notification.error),
    nowISO(),
    notification.stripeInvoiceId
  );
}

function beginStripeWebhookEvent(db, event) {
  const timestamp = nowISO();

  db.prepare(`
    INSERT OR IGNORE INTO stripe_webhook_events (
      stripe_event_id,
      type,
      livemode,
      stripe_created_at,
      received_at,
      processed_at,
      processing_error
    )
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
  `).run(
    event.id,
    event.type,
    event.livemode ? 1 : 0,
    event.createdAt || null,
    timestamp
  );

  const row = db
    .prepare(`
      SELECT *
      FROM stripe_webhook_events
      WHERE stripe_event_id = ?
      LIMIT 1
    `)
    .get(event.id);

  return {
    alreadyProcessed: Boolean(row.processed_at),
    event: row,
  };
}

function markStripeWebhookEventProcessed(db, stripeEventId) {
  db.prepare(`
    UPDATE stripe_webhook_events
    SET processed_at = ?,
      processing_error = NULL
    WHERE stripe_event_id = ?
  `).run(nowISO(), stripeEventId);
}

function markStripeWebhookEventFailed(db, stripeEventId, error) {
  db.prepare(`
    UPDATE stripe_webhook_events
    SET processing_error = ?
    WHERE stripe_event_id = ?
  `).run(String(error.message || error), stripeEventId);
}

module.exports = {
  openDatabase,
  getDatabasePath,
  getActiveCreatorInvites,
  getStoredAttributionForUser,
  recordJoinAttribution,
  upsertPartnershipConversation,
  migrateConversationsFromJson,
  getPartnershipConversationByChannelId,
  getStripeCustomerForDiscordUser,
  saveStripeCustomer,
  upsertStripeCheckoutSession,
  getStripeCheckoutSession,
  updateStripeCheckoutSessionStatus,
  upsertBrandSubscription,
  updateSubscriptionInvoiceStatus,
  getBrandSubscription,
  getPartnershipConversationById,
  claimStripePaidConfirmation,
  markStripePaidConfirmationSent,
  markStripePaidConfirmationFailed,
  beginStripeWebhookEvent,
  markStripeWebhookEventProcessed,
  markStripeWebhookEventFailed,
};
