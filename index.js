require("dotenv").config();

const fs = require("fs");
const path = require("path");

const {
  Client,
  Events,
  GatewayIntentBits,
  ChannelType,
  PermissionFlagsBits,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
} = require("discord.js");

const {
  openDatabase,
  getDatabasePath,
  getActiveCreatorInvites,
  getStoredAttributionForUser,
  recordJoinAttribution,
  upsertPartnershipConversation,
  migrateConversationsFromJson,
} = require("./database");

const {
  createGuildTaskQueue,
  determineInviteAttribution,
  mergeInviteSnapshot,
  snapshotInvites,
} = require("./attribution");

// ============================================================
// CONFIG
// ============================================================

const {
  DISCORD_TOKEN,
  GUILD_ID,
  WORK_WITH_US_CHANNEL_ID,
  ADMIN_ROLE_ID,
  ACTIVE_CATEGORY_ID,
  ARCHIVED_CATEGORY_ID,
} = process.env;

const REQUIRED_ENV = {
  DISCORD_TOKEN,
  GUILD_ID,
  WORK_WITH_US_CHANNEL_ID,
  ADMIN_ROLE_ID,
};

for (const [key, value] of Object.entries(REQUIRED_ENV)) {
  if (!value || !value.trim()) {
    console.error(`❌ Missing required .env value: ${key}`);
    process.exit(1);
  }
}

const CONVERSATIONS_FILE = path.join(__dirname, "conversations.json");
const STATE_FILE = path.join(__dirname, "state.json");

const db = openDatabase();

// ============================================================
// JSON STORAGE
// ============================================================

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Could not read ${path.basename(file)}. Using fallback.`);
    return fallback;
  }
}

function writeJSON(file, data) {
  const tempFile = `${file}.tmp`;

  fs.writeFileSync(
    tempFile,
    JSON.stringify(data, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, file);
}

function loadConversations() {
  return readJSON(CONVERSATIONS_FILE, []);
}

function saveConversations(conversations) {
  writeJSON(CONVERSATIONS_FILE, conversations);
}

function loadState() {
  return readJSON(STATE_FILE, {
    nextConversationId: 1,
    panelMessageId: null,
    activeCategoryId: null,
    archivedCategoryId: null,
  });
}

function saveState(state) {
  writeJSON(STATE_FILE, state);
}

function paddedId(number) {
  return String(number).padStart(3, "0");
}

// ============================================================
// CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
  ],
});

// ============================================================
// DISCORD INVITE ATTRIBUTION
// ============================================================

const inviteCacheByGuild = new Map();
const enqueueGuildInviteAttribution =
  createGuildTaskQueue();

function buildCreatorInviteMap(guildId) {
  const rows = getActiveCreatorInvites(db, guildId);
  const byCode = new Map();

  for (const row of rows) {
    byCode.set(row.discord_invite_code, row);
  }

  return byCode;
}

async function hydrateInviteCache(guild) {
  const invites = await guild.invites.fetch();
  inviteCacheByGuild.set(guild.id, snapshotInvites(invites));

  console.log(
    `✅ Invite cache hydrated: ${invites.size} invite(s)`
  );
}

async function refreshInviteCache(guild) {
  try {
    const invites = await guild.invites.fetch();
    const previousSnapshot =
      inviteCacheByGuild.get(guild.id);

    inviteCacheByGuild.set(
      guild.id,
      mergeInviteSnapshot({
        previousSnapshot,
        currentInvites: invites,
      })
    );

    console.log(
      `✅ Invite cache refreshed: ${invites.size} invite(s)`
    );
  } catch (error) {
    console.warn(
      "Could not refresh invite cache:",
      error.message
    );
  }
}

async function recordGuildMemberAttribution(member) {
  if (member.guild.id !== GUILD_ID) {
    return;
  }

  return enqueueGuildInviteAttribution(
    member.guild.id,
    () => processGuildMemberAttribution(member)
  );
}

async function processGuildMemberAttribution(member) {
  const joinedAt = new Date().toISOString();
  let currentInvites;

  try {
    currentInvites = await member.guild.invites.fetch();
  } catch (error) {
    recordJoinAttribution(db, {
      guildId: member.guild.id,
      discordUserId: member.user.id,
      status: "unattributed",
      reason: "invite_fetch_failed",
      joinedAt,
    });

    console.warn(
      `⚠️ Could not fetch invites for ${member.user.tag}; stored unattributed join.`
    );

    return;
  }

  const previousSnapshot =
    inviteCacheByGuild.get(member.guild.id);
  const result = determineInviteAttribution({
    previousSnapshot,
    currentInvites,
    creatorInviteByCode:
      buildCreatorInviteMap(member.guild.id),
  });

  inviteCacheByGuild.set(
    member.guild.id,
    snapshotInvites(currentInvites)
  );

  if (result.status === "attributed") {
    const saved = recordJoinAttribution(db, {
      guildId: member.guild.id,
      discordUserId: member.user.id,
      creatorId: result.creatorInvite.creator_id,
      creatorInviteId:
        result.creatorInvite.creator_invite_id,
      discordInviteCode: result.inviteCode,
      status: "attributed",
      reason: result.reason,
      joinedAt,
    });

    if (saved.inserted) {
      console.log(
        `✅ Attributed ${member.user.tag} to creator ${result.creatorInvite.creator_id} via invite ${result.inviteCode}.`
      );
    } else {
      console.log(
        `Existing join attribution preserved for ${member.user.tag}.`
      );
    }

    return;
  }

  recordJoinAttribution(db, {
    guildId: member.guild.id,
    discordUserId: member.user.id,
    discordInviteCode: result.inviteCode || null,
    status: result.status,
    reason: result.reason,
    joinedAt,
  });

  console.log(
    `Join ${result.status} for ${member.user.tag}: ${result.reason}.`
  );
}

// ============================================================
// PERMISSION HELPERS
// ============================================================

function adminCategoryPermissions(guild) {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
      ],
    },
    {
      id: ADMIN_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
      ],
    },
  ];
}

function activeChannelPermissions(guild, userId) {
  return [
    {
      id: guild.roles.everyone.id,
      deny: [
        PermissionFlagsBits.ViewChannel,
      ],
    },

    // Person who opened the conversation
    {
      id: userId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.UseExternalEmojis,
      ],
      deny: [
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },

    // Admin team
    {
      id: ADMIN_ROLE_ID,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
      ],
    },

    // Bot
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ManageMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
      ],
    },
  ];
}

async function memberIsAdmin(interaction) {
  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);

    return (
      member.roles.cache.has(ADMIN_ROLE_ID) ||
      member.permissions.has(PermissionFlagsBits.Administrator)
    );
  } catch {
    return false;
  }
}

// ============================================================
// CATEGORY SETUP
// ============================================================

async function getOrCreateCategory({
  guild,
  envId,
  stateKey,
  name,
}) {
  const state = loadState();

  if (envId) {
    try {
      const category = await guild.channels.fetch(envId);

      if (
        category &&
        category.type === ChannelType.GuildCategory
      ) {
        state[stateKey] = category.id;
        saveState(state);
        return category;
      }
    } catch {
      console.warn(
        `⚠️ Could not use configured category ${envId}.`
      );
    }
  }

  if (state[stateKey]) {
    try {
      const category = await guild.channels.fetch(
        state[stateKey]
      );

      if (
        category &&
        category.type === ChannelType.GuildCategory
      ) {
        return category;
      }
    } catch {
      console.warn(
        `⚠️ Saved ${name} category no longer exists.`
      );
    }
  }

  console.log(`Creating category: ${name}`);

  const category = await guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    reason: "Brand partnership bot setup",
  });

  state[stateKey] = category.id;
  saveState(state);

  return category;
}

// ============================================================
// PUBLIC PANEL
// ============================================================

function buildPublicPanel() {
  const embed = new EmbedBuilder()
    .setTitle("Work With Us")
    .setDescription(
      [
        "Interested in working with our creator network?",
        "",
        "Open a private conversation with our team below.",
      ].join("\n")
    );

  const button = new ButtonBuilder()
    .setCustomId("open_partnership")
    .setLabel("Start a Conversation")
    .setEmoji("🤝")
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(button);

  return {
    embeds: [embed],
    components: [row],
  };
}

async function ensurePublicPanel(guild) {
  const channel = await guild.channels.fetch(
    WORK_WITH_US_CHANNEL_ID
  );

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    throw new Error(
      "WORK_WITH_US_CHANNEL_ID must point to a text channel."
    );
  }

  const state = loadState();
  const panel = buildPublicPanel();

  // If we already have a saved panel, update it instead of duplicating it.
  if (state.panelMessageId) {
    try {
      const existing = await channel.messages.fetch(
        state.panelMessageId
      );

      await existing.edit(panel);

      console.log("✅ Existing Work With Us panel updated.");
      return existing;
    } catch {
      console.log(
        "Saved panel not found. Creating a new one."
      );
    }
  }

  const message = await channel.send(panel);

  state.panelMessageId = message.id;
  saveState(state);

  console.log("✅ Work With Us panel created.");

  return message;
}

// ============================================================
// PRIVATE CONVERSATION MESSAGE
// ============================================================

function buildConversationWelcome(user, conversationNumber) {
  const embed = new EmbedBuilder()
    .setTitle("🤝 Partnership Conversation")
    .setDescription(
      [
        "Thanks for reaching out!",
        "",
        "This is a private conversation between you and our team.",
        "",
        "Tell us a little about your brand, what you're looking for, and anything else you'd like us to know. Someone from our team will follow up here.",
        "",
        `**Opened by:** <@${user.id}>`,
        `**Conversation:** #${paddedId(conversationNumber)}`,
      ].join("\n")
    );

  const archiveButton = new ButtonBuilder()
    .setCustomId("archive_partnership")
    .setLabel("Archive Conversation")
    .setEmoji("📁")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(
    archiveButton
  );

  return {
    content: `<@${user.id}> <@&${ADMIN_ROLE_ID}>`,
    embeds: [embed],
    components: [row],
    allowedMentions: {
      users: [user.id],
      roles: [ADMIN_ROLE_ID],
    },
  };
}

// ============================================================
// CREATE CONVERSATION
// ============================================================

async function createConversation(interaction) {
  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const guild = interaction.guild;
  const user = interaction.user;
  const storedAttribution =
    getStoredAttributionForUser(
      db,
      guild.id,
      user.id
    );

  let conversations = loadConversations();

  // ----------------------------------------------------------
  // Prevent duplicate active conversations
  // ----------------------------------------------------------

  const existing = conversations.find(
    (conversation) =>
      conversation.userId === user.id &&
      conversation.status === "active"
  );

  if (existing) {
    try {
      const existingChannel = await guild.channels.fetch(
        existing.channelId
      );

      if (existingChannel) {
        await interaction.editReply({
          content:
            `You already have an open conversation with our team: ${existingChannel}`,
        });

        return;
      }
    } catch {
      // Channel no longer exists, mark old record stale.
      existing.status = "missing";
      existing.missingAt = new Date().toISOString();

      saveConversations(conversations);

      upsertPartnershipConversation(db, {
        conversationId: existing.conversationId,
        channelId: existing.channelId,
        guildId: guild.id,
        discordUserId: existing.userId,
        status: existing.status,
        createdAt: existing.createdAt,
        archivedAt: existing.archivedAt,
        archivedBy: existing.archivedBy,
      });
    }
  }

  // ----------------------------------------------------------
  // Load state and category
  // ----------------------------------------------------------

  const state = loadState();

  const activeCategory = await getOrCreateCategory({
    guild,
    envId: ACTIVE_CATEGORY_ID,
    stateKey: "activeCategoryId",
    name: "ACTIVE PARTNERSHIPS",
  });

  const conversationNumber =
    Number(state.nextConversationId) || 1;

  const displayId = paddedId(conversationNumber);

  // ----------------------------------------------------------
  // Create private channel
  // ----------------------------------------------------------

  const channel = await guild.channels.create({
    name: `partnership-${displayId}`,
    type: ChannelType.GuildText,
    parent: activeCategory.id,

    topic:
      `Partnership #${displayId} | Opened by ${user.username} | User ID: ${user.id}`,

    permissionOverwrites:
      activeChannelPermissions(guild, user.id),

    reason:
      `Partnership conversation opened by ${user.username}`,
  });

  // ----------------------------------------------------------
  // Persist immediately
  // ----------------------------------------------------------

  const record = {
    conversationId: conversationNumber,
    channelId: channel.id,
    userId: user.id,
    username: user.username,
    status: "active",
    createdAt: new Date().toISOString(),
    archivedAt: null,
    archivedBy: null,
  };

  conversations.push(record);
  saveConversations(conversations);

  upsertPartnershipConversation(db, {
    conversationId: conversationNumber,
    channelId: channel.id,
    guildId: guild.id,
    discordUserId: user.id,
    creatorId: storedAttribution
      ? storedAttribution.creator_id
      : null,
    creatorInviteId: storedAttribution
      ? storedAttribution.creator_invite_id
      : null,
    creatorInviteCode: storedAttribution
      ? storedAttribution.discord_invite_code
      : null,
    status: "active",
    createdAt: record.createdAt,
    archivedAt: null,
    archivedBy: null,
  });

  state.nextConversationId =
    conversationNumber + 1;

  saveState(state);

  // ----------------------------------------------------------
  // Send welcome
  // ----------------------------------------------------------

  await channel.send(
    buildConversationWelcome(
      user,
      conversationNumber
    )
  );

  // ----------------------------------------------------------
  // Tell user where it is
  // ----------------------------------------------------------

  await interaction.editReply({
    content:
      `Your private conversation has been created: ${channel}`,
  });

  console.log(
    `✅ Created partnership-${displayId} for ${user.username}`
  );

  if (storedAttribution) {
    console.log(
      `✅ Partnership #${displayId} linked to creator ${storedAttribution.creator_id}.`
    );
  }
}

// ============================================================
// ARCHIVE CONVERSATION
// ============================================================

async function archiveConversation(interaction) {
  const isAdmin = await memberIsAdmin(interaction);

  if (!isAdmin) {
    await interaction.reply({
      content:
        "You don't have permission to archive this conversation.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const guild = interaction.guild;
  const channel = interaction.channel;

  let conversations = loadConversations();

  const conversation = conversations.find(
    (item) => item.channelId === channel.id
  );

  if (!conversation) {
    await interaction.editReply({
      content:
        "I couldn't find a conversation record for this channel.",
    });

    return;
  }

  if (conversation.status !== "active") {
    await interaction.editReply({
      content:
        "This conversation is already archived.",
    });

    return;
  }

  const archivedCategory =
    await getOrCreateCategory({
      guild,
      envId: ARCHIVED_CATEGORY_ID,
      stateKey: "archivedCategoryId",
      name: "ARCHIVED PARTNERSHIPS",
    });

  const displayId = paddedId(
    conversation.conversationId
  );

  // ----------------------------------------------------------
  // Remove original user's access
  // ----------------------------------------------------------

  try {
    await channel.permissionOverwrites.delete(
      conversation.userId,
      "Partnership conversation archived"
    );
  } catch (error) {
    console.warn(
      "Could not delete user's overwrite:",
      error.message
    );
  }

  // Explicitly deny access as an extra safeguard.
  await channel.permissionOverwrites.edit(
    conversation.userId,
    {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    },
    {
      reason:
        "Partnership conversation archived",
    }
  );

  // ----------------------------------------------------------
  // Move + rename
  // ----------------------------------------------------------

  await channel.setParent(
    archivedCategory.id,
    {
      lockPermissions: false,
      reason: "Partnership conversation archived",
    }
  );

  await channel.setName(
    `archived-${displayId}`,
    "Partnership conversation archived"
  );

  // ----------------------------------------------------------
  // Update record
  // ----------------------------------------------------------

  conversation.status = "archived";
  conversation.archivedAt =
    new Date().toISOString();
  conversation.archivedBy =
    interaction.user.id;

  saveConversations(conversations);

  upsertPartnershipConversation(db, {
    conversationId: conversation.conversationId,
    channelId: conversation.channelId,
    guildId: guild.id,
    discordUserId: conversation.userId,
    status: conversation.status,
    createdAt: conversation.createdAt,
    archivedAt: conversation.archivedAt,
    archivedBy: conversation.archivedBy,
  });

  // ----------------------------------------------------------
  // Disable archive button on original message
  // ----------------------------------------------------------

  try {
    const disabledButton =
      new ButtonBuilder()
        .setCustomId("archive_partnership")
        .setLabel("Conversation Archived")
        .setEmoji("📁")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true);

    const disabledRow =
      new ActionRowBuilder().addComponents(
        disabledButton
      );

    await interaction.message.edit({
      components: [disabledRow],
    });
  } catch (error) {
    console.warn(
      "Could not disable archive button:",
      error.message
    );
  }

  // ----------------------------------------------------------
  // Post archive notice
  // ----------------------------------------------------------

  await channel.send({
    content:
      `📁 This conversation was archived by <@${interaction.user.id}>.`,
    allowedMentions: {
      users: [interaction.user.id],
    },
  });

  await interaction.editReply({
    content:
      `Conversation #${displayId} has been archived.`,
  });

  console.log(
    `📁 Archived partnership-${displayId} by ${interaction.user.username}`
  );
}

// ============================================================
// INTERACTIONS
// ============================================================

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    if (!interaction.isButton()) return;

    try {
      if (
        interaction.customId ===
        "open_partnership"
      ) {
        if (
          interaction.guildId !== GUILD_ID
        ) {
          await interaction.reply({
            content:
              "This button isn't configured for this server.",
            flags: MessageFlags.Ephemeral,
          });

          return;
        }

        await createConversation(interaction);
        return;
      }

      if (
        interaction.customId ===
        "archive_partnership"
      ) {
        await archiveConversation(interaction);
        return;
      }
    } catch (error) {
      console.error(
        "❌ Interaction error:",
        error
      );

      const payload = {
        content:
          "Something went wrong. Please contact an administrator.",
        flags: MessageFlags.Ephemeral,
      };

      try {
        if (
          interaction.deferred ||
          interaction.replied
        ) {
          await interaction.editReply({
            content: payload.content,
          });
        } else {
          await interaction.reply(payload);
        }
      } catch (secondaryError) {
        console.error(
          "Could not send error response:",
          secondaryError
        );
      }
    }
  }
);

client.on(
  Events.GuildMemberAdd,
  async (member) => {
    try {
      await recordGuildMemberAttribution(member);
    } catch (error) {
      console.error(
        "❌ Guild member attribution error:",
        error
      );
    }
  }
);

client.on(
  Events.InviteCreate,
  async (invite) => {
    if (invite.guild && invite.guild.id === GUILD_ID) {
      await refreshInviteCache(invite.guild);
    }
  }
);

client.on(
  Events.InviteDelete,
  async (invite) => {
    if (invite.guild && invite.guild.id === GUILD_ID) {
      console.log(
        `Invite deleted: ${invite.code}. Cache will refresh after the next successful join attribution or invite creation.`
      );
    }
  }
);

// ============================================================
// STARTUP
// ============================================================

client.once(
  Events.ClientReady,
  async (readyClient) => {
    console.log(
      `\n✅ Logged in as ${readyClient.user.tag}`
    );

    try {
      const guild = await client.guilds.fetch(
        GUILD_ID
      );

      console.log(
        `✅ Server: ${guild.name}`
      );

      migrateConversationsFromJson(
        db,
        loadConversations(),
        guild.id
      );

      console.log(
        `✅ SQLite database: ${getDatabasePath()}`
      );

      // Validate admin role
      const adminRole =
        await guild.roles.fetch(
          ADMIN_ROLE_ID
        );

      if (!adminRole) {
        throw new Error(
          "ADMIN_ROLE_ID does not exist."
        );
      }

      console.log(
        `✅ Admin role: ${adminRole.name}`
      );

      // Ensure both categories exist
      const activeCategory =
        await getOrCreateCategory({
          guild,
          envId: ACTIVE_CATEGORY_ID,
          stateKey: "activeCategoryId",
          name: "ACTIVE PARTNERSHIPS",
        });

      console.log(
        `✅ Active category: ${activeCategory.name}`
      );

      const archivedCategory =
        await getOrCreateCategory({
          guild,
          envId: ARCHIVED_CATEGORY_ID,
          stateKey: "archivedCategoryId",
          name: "ARCHIVED PARTNERSHIPS",
        });

      console.log(
        `✅ Archived category: ${archivedCategory.name}`
      );

      // Ensure public panel exists
      await ensurePublicPanel(guild);

      // Snapshot current invite uses for deterministic future joins.
      await hydrateInviteCache(guild);

      const state = loadState();

      console.log(
        `✅ Next conversation: #${paddedId(
          state.nextConversationId
        )}`
      );

      console.log(
        "\n🚀 Brand Partnership Bot is ready.\n"
      );
    } catch (error) {
      console.error(
        "\n❌ Startup configuration error:"
      );
      console.error(error);

      console.error(
        "\nFix the configuration and restart with: npm start\n"
      );
    }
  }
);

// ============================================================
// PROCESS ERROR LOGGING
// ============================================================

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "Unhandled promise rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

// ============================================================
// LOGIN
// ============================================================

client.login(DISCORD_TOKEN);
