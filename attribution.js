function inviteUses(invite) {
  return Number(invite.uses) || 0;
}

function inviteMaxUses(invite) {
  return Number(invite.maxUses) || 0;
}

function snapshotInvites(invites) {
  const snapshot = new Map();

  for (const invite of invites.values()) {
    snapshot.set(invite.code, {
      code: invite.code,
      uses: inviteUses(invite),
      maxUses: inviteMaxUses(invite),
    });
  }

  return snapshot;
}

function mergeInviteSnapshot({
  previousSnapshot,
  currentInvites,
}) {
  const nextSnapshot = snapshotInvites(currentInvites);

  if (!previousSnapshot) {
    return nextSnapshot;
  }

  for (const previous of previousSnapshot.values()) {
    if (
      !nextSnapshot.has(previous.code) &&
      inviteWasProbablyConsumedByFinalUse(previous)
    ) {
      nextSnapshot.set(previous.code, previous);
    }
  }

  return nextSnapshot;
}

function inviteWasProbablyConsumedByFinalUse(invite) {
  return (
    invite.maxUses > 0 &&
    invite.uses + 1 >= invite.maxUses
  );
}

function determineInviteAttribution({
  previousSnapshot,
  currentInvites,
  creatorInviteByCode,
}) {
  if (!previousSnapshot) {
    return {
      status: "unattributed",
      reason: "invite_cache_missing",
      inviteCode: null,
      creatorInvite: null,
      evidence: [],
    };
  }

  const currentSnapshot = snapshotInvites(currentInvites);
  const evidence = [];

  for (const invite of currentSnapshot.values()) {
    const previous = previousSnapshot.get(invite.code);

    if (previous && invite.uses > previous.uses) {
      evidence.push({
        type: "incremented",
        code: invite.code,
        usesBefore: previous.uses,
        usesAfter: invite.uses,
      });
    }
  }

  for (const previous of previousSnapshot.values()) {
    if (
      !currentSnapshot.has(previous.code) &&
      inviteWasProbablyConsumedByFinalUse(previous)
    ) {
      evidence.push({
        type: "disappeared_after_final_use",
        code: previous.code,
        usesBefore: previous.uses,
        usesAfter: previous.maxUses,
      });
    }
  }

  if (evidence.length === 0) {
    return {
      status: "unattributed",
      reason: "no_invite_increment",
      inviteCode: null,
      creatorInvite: null,
      evidence,
    };
  }

  if (evidence.length > 1) {
    return {
      status: "ambiguous",
      reason: "multiple_possible_invite_matches",
      inviteCode: evidence.map((item) => item.code).join(","),
      creatorInvite: null,
      evidence,
    };
  }

  const [match] = evidence;
  const creatorInvite =
    creatorInviteByCode.get(match.code);

  if (!creatorInvite) {
    return {
      status: "unattributed",
      reason: "invite_not_creator_owned",
      inviteCode: match.code,
      creatorInvite: null,
      evidence,
    };
  }

  return {
    status: "attributed",
    reason:
      match.type === "disappeared_after_final_use"
        ? "single_creator_invite_disappeared_after_final_use"
        : "single_creator_invite_increment",
    inviteCode: match.code,
    creatorInvite,
    evidence,
  };
}

function createGuildTaskQueue() {
  const activeByGuild = new Map();

  return function enqueueGuildTask(guildId, task) {
    const previous =
      activeByGuild.get(guildId) || Promise.resolve();

    const current = previous
      .catch(() => {})
      .then(task);

    activeByGuild.set(guildId, current);

    current.then(
      () => {
        if (activeByGuild.get(guildId) === current) {
          activeByGuild.delete(guildId);
        }
      },
      () => {
        if (activeByGuild.get(guildId) === current) {
          activeByGuild.delete(guildId);
        }
      }
    );

    return current;
  };
}

module.exports = {
  createGuildTaskQueue,
  determineInviteAttribution,
  mergeInviteSnapshot,
  snapshotInvites,
};
