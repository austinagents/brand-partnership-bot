const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createGuildTaskQueue,
  determineInviteAttribution,
  mergeInviteSnapshot,
  snapshotInvites,
} = require("../attribution");

function nextTick() {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function invites(items) {
  return new Map(
    items.map((item) => [
      item.code,
      {
        code: item.code,
        uses: item.uses,
        maxUses: item.maxUses || 0,
      },
    ])
  );
}

function creatorInvites(items) {
  return new Map(
    items.map((item) => [
      item.code,
      {
        creator_invite_id: item.creatorInviteId,
        creator_id: item.creatorId,
        discord_invite_code: item.code,
      },
    ])
  );
}

test("attributes exactly one creator invite increment", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([{ code: "creator", uses: 2 }])
    ),
    currentInvites: invites([{ code: "creator", uses: 3 }]),
    creatorInviteByCode: creatorInvites([
      {
        code: "creator",
        creatorInviteId: 10,
        creatorId: 20,
      },
    ]),
  });

  assert.equal(result.status, "attributed");
  assert.equal(
    result.reason,
    "single_creator_invite_increment"
  );
  assert.equal(result.inviteCode, "creator");
  assert.equal(result.creatorInvite.creator_id, 20);
});

test("does not attribute one non-creator invite increment", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([{ code: "public", uses: 4 }])
    ),
    currentInvites: invites([{ code: "public", uses: 5 }]),
    creatorInviteByCode: creatorInvites([]),
  });

  assert.equal(result.status, "unattributed");
  assert.equal(result.reason, "invite_not_creator_owned");
  assert.equal(result.inviteCode, "public");
});

test("does not attribute when no invite incremented", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([{ code: "creator", uses: 2 }])
    ),
    currentInvites: invites([{ code: "creator", uses: 2 }]),
    creatorInviteByCode: creatorInvites([
      {
        code: "creator",
        creatorInviteId: 10,
        creatorId: 20,
      },
    ]),
  });

  assert.equal(result.status, "unattributed");
  assert.equal(result.reason, "no_invite_increment");
  assert.equal(result.inviteCode, null);
});

test("marks multiple invite increments ambiguous", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([
        { code: "a", uses: 1 },
        { code: "b", uses: 1 },
      ])
    ),
    currentInvites: invites([
      { code: "a", uses: 2 },
      { code: "b", uses: 2 },
    ]),
    creatorInviteByCode: creatorInvites([
      { code: "a", creatorInviteId: 1, creatorId: 1 },
      { code: "b", creatorInviteId: 2, creatorId: 2 },
    ]),
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(
    result.reason,
    "multiple_possible_invite_matches"
  );
  assert.equal(result.inviteCode, "a,b");
});

test("attributes creator invite disappeared after final use", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([
        {
          code: "singleUse",
          uses: 0,
          maxUses: 1,
        },
      ])
    ),
    currentInvites: invites([]),
    creatorInviteByCode: creatorInvites([
      {
        code: "singleUse",
        creatorInviteId: 11,
        creatorId: 22,
      },
    ]),
  });

  assert.equal(result.status, "attributed");
  assert.equal(
    result.reason,
    "single_creator_invite_disappeared_after_final_use"
  );
  assert.equal(result.inviteCode, "singleUse");
});

test("marks multiple possible disappeared invites ambiguous", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(
      invites([
        { code: "a", uses: 0, maxUses: 1 },
        { code: "b", uses: 4, maxUses: 5 },
      ])
    ),
    currentInvites: invites([]),
    creatorInviteByCode: creatorInvites([
      { code: "a", creatorInviteId: 1, creatorId: 1 },
      { code: "b", creatorInviteId: 2, creatorId: 2 },
    ]),
  });

  assert.equal(result.status, "ambiguous");
  assert.equal(
    result.reason,
    "multiple_possible_invite_matches"
  );
  assert.equal(result.inviteCode, "a,b");
});

test("startup without cache cannot attribute", () => {
  const result = determineInviteAttribution({
    previousSnapshot: undefined,
    currentInvites: invites([{ code: "creator", uses: 1 }]),
    creatorInviteByCode: creatorInvites([
      {
        code: "creator",
        creatorInviteId: 10,
        creatorId: 20,
      },
    ]),
  });

  assert.equal(result.status, "unattributed");
  assert.equal(result.reason, "invite_cache_missing");
});

test("unknown invite code without prior baseline cannot attribute", () => {
  const result = determineInviteAttribution({
    previousSnapshot: snapshotInvites(invites([])),
    currentInvites: invites([{ code: "creator", uses: 3 }]),
    creatorInviteByCode: creatorInvites([
      {
        code: "creator",
        creatorInviteId: 10,
        creatorId: 20,
      },
    ]),
  });

  assert.equal(result.status, "unattributed");
  assert.equal(result.reason, "no_invite_increment");
});

test("cache refresh preserves final-use disappearance evidence", () => {
  const previousSnapshot = snapshotInvites(
    invites([
      {
        code: "singleUse",
        uses: 0,
        maxUses: 1,
      },
    ])
  );

  const merged = mergeInviteSnapshot({
    previousSnapshot,
    currentInvites: invites([{ code: "newInvite", uses: 0 }]),
  });

  assert.equal(merged.has("singleUse"), true);
  assert.equal(merged.has("newInvite"), true);
});

test("serializes tasks per guild", async () => {
  const enqueueGuildTask = createGuildTaskQueue();
  const events = [];
  let releaseFirst;

  const firstStarted = enqueueGuildTask("guild-a", async () => {
    events.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
  });

  const secondStarted = enqueueGuildTask("guild-a", async () => {
    events.push("second:start");
  });

  await nextTick();
  assert.equal(
    JSON.stringify(events),
    JSON.stringify(["first:start"])
  );

  releaseFirst();
  await Promise.all([firstStarted, secondStarted]);

  assert.equal(
    JSON.stringify(events),
    JSON.stringify([
      "first:start",
      "first:end",
      "second:start",
    ])
  );
});

test("does not block different guilds", async () => {
  const enqueueGuildTask = createGuildTaskQueue();
  const events = [];
  let releaseFirst;

  const first = enqueueGuildTask("guild-a", async () => {
    events.push("guild-a:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
  });

  const second = enqueueGuildTask("guild-b", async () => {
    events.push("guild-b:start");
  });

  await nextTick();
  assert.equal(
    JSON.stringify(events),
    JSON.stringify([
      "guild-a:start",
      "guild-b:start",
    ])
  );

  releaseFirst();
  await Promise.all([first, second]);
});
