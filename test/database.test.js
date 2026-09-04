const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function loadDatabaseModule(databasePath) {
  process.env.SQLITE_DATABASE_PATH = databasePath;
  delete require.cache[require.resolve("../database")];
  return require("../database");
}

test("recordJoinAttribution never overwrites an existing row", () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "brand-bot-db-")
  );
  const databasePath = path.join(dir, "test.sqlite");
  const dbm = loadDatabaseModule(databasePath);
  const db = dbm.openDatabase();

  const timestamp = new Date().toISOString();

  db.prepare(`
    INSERT INTO creators (
      discord_user_id,
      display_name,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?)
  `).run("creator-user", "Creator", "active", timestamp, timestamp);

  const creator = db
    .prepare("SELECT id FROM creators LIMIT 1")
    .get();

  db.prepare(`
    INSERT INTO creator_invites (
      creator_id,
      discord_invite_code,
      guild_id,
      status,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    creator.id,
    "creator-code",
    "guild-1",
    "active",
    timestamp,
    timestamp
  );

  const invite = db
    .prepare("SELECT id FROM creator_invites LIMIT 1")
    .get();

  const first = dbm.recordJoinAttribution(db, {
    guildId: "guild-1",
    discordUserId: "brand-user",
    creatorId: creator.id,
    creatorInviteId: invite.id,
    discordInviteCode: "creator-code",
    status: "attributed",
    reason: "single_creator_invite_increment",
    joinedAt: timestamp,
  });

  const second = dbm.recordJoinAttribution(db, {
    guildId: "guild-1",
    discordUserId: "brand-user",
    status: "unattributed",
    reason: "invite_fetch_failed",
    joinedAt: timestamp,
  });

  const row = db
    .prepare(`
      SELECT status, creator_id, discord_invite_code, reason
      FROM discord_join_attributions
      WHERE guild_id = ?
        AND discord_user_id = ?
    `)
    .get("guild-1", "brand-user");

  assert.equal(first.inserted, true);
  assert.equal(second.inserted, false);
  assert.equal(row.status, "attributed");
  assert.equal(row.creator_id, creator.id);
  assert.equal(row.discord_invite_code, "creator-code");
  assert.equal(row.reason, "single_creator_invite_increment");

  db.close();
});
