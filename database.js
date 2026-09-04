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

module.exports = {
  openDatabase,
  getDatabasePath,
  getActiveCreatorInvites,
  getStoredAttributionForUser,
  recordJoinAttribution,
  upsertPartnershipConversation,
  migrateConversationsFromJson,
};
