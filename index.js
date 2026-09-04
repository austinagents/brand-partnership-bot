require("dotenv").config();

const fs = require("fs");
const http = require("http");
const path = require("path");
const Stripe = require("stripe");

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
  InteractionResponseType,
  MessageFlags,
  Routes,
} = require("discord.js");

const {
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
} = require("./database");

const {
  createGuildTaskQueue,
  determineInviteAttribution,
  mergeInviteSnapshot,
  snapshotInvites,
} = require("./attribution");

const {
  PLAN_MARKETPLACE_AFFILIATE,
  PLAN_MARKETPLACE_MANAGEMENT,
  buildBillingMetadata,
  buildCheckoutPrompt,
  completePaidConfirmation,
  failPaidConfirmation,
  getBillingPlans,
  getPlanByKey,
  processStripeWebhookEvent,
} = require("./billing");

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
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PUBLIC_BASE_URL,
  HTTP_PORT,
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
let stripeClient = null;

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
// BILLING HELPERS
// ============================================================

function getStripeClient() {
  if (!STRIPE_SECRET_KEY || !STRIPE_SECRET_KEY.trim()) {
    throw new Error("Missing STRIPE_SECRET_KEY.");
  }

  if (STRIPE_SECRET_KEY.startsWith("sk_live_")) {
    throw new Error(
      "Live Stripe keys are disabled for this beta deployment."
    );
  }

  if (!stripeClient) {
    stripeClient = new Stripe(STRIPE_SECRET_KEY);
  }

  return stripeClient;
}

function requirePublicBaseUrl() {
  if (!PUBLIC_BASE_URL || !PUBLIC_BASE_URL.trim()) {
    throw new Error("Missing PUBLIC_BASE_URL.");
  }

  return PUBLIC_BASE_URL.replace(/\/+$/, "");
}

function getConfiguredBillingPlans() {
  return getBillingPlans(process.env);
}

function requireBillingConversation(interaction) {
  const conversation =
    getPartnershipConversationByChannelId(
      db,
      interaction.channelId
    );

  if (!conversation) {
    throw new Error(
      "No partnership conversation record found for this channel."
    );
  }

  if (
    conversation.discord_user_id !== interaction.user.id
  ) {
    return {
      conversation,
      allowed: false,
    };
  }

  return {
    conversation,
    allowed: true,
  };
}

async function getOrCreateStripeCustomer({
  stripe,
  conversation,
  user,
}) {
  const existing = getStripeCustomerForDiscordUser(
    db,
    conversation.guild_id,
    conversation.discord_user_id
  );

  if (existing) {
    return existing;
  }

  const customer = await stripe.customers.create(
    {
      description:
        `Discord user ${user.tag || user.id}`,
      metadata: {
        guild_id: conversation.guild_id,
        discord_user_id:
          conversation.discord_user_id,
      },
    },
    {
      idempotencyKey:
        `customer:${conversation.guild_id}:${conversation.discord_user_id}`,
    }
  );

  return saveStripeCustomer(db, {
    guildId: conversation.guild_id,
    discordUserId: conversation.discord_user_id,
    stripeCustomerId: customer.id,
  });
}

function isoFromStripeTimestamp(timestamp) {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

function buildCheckoutUrls() {
  const baseUrl = requirePublicBaseUrl();

  return {
    successUrl:
      `${baseUrl}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${baseUrl}/stripe/cancel`,
  };
}

async function createStripeCheckout(interaction, planKey) {
  const { conversation, allowed } =
    requireBillingConversation(interaction);

  if (!allowed) {
    await interaction.reply({
      content:
        "Only the person who opened this partnership conversation can use billing.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const stripe = getStripeClient();
  const plans = getConfiguredBillingPlans();
  const plan = getPlanByKey(plans, planKey);
  const customer = await getOrCreateStripeCustomer({
    stripe,
    conversation,
    user: interaction.user,
  });
  const metadata = buildBillingMetadata(
    conversation,
    plan.key
  );
  const { successUrl, cancelUrl } = buildCheckoutUrls();

  const session =
    await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        customer: customer.stripe_customer_id,
        client_reference_id:
          `${conversation.guild_id}:${conversation.discord_user_id}:${conversation.conversation_id}`,
        line_items: [
          {
            price: plan.priceId,
            quantity: 1,
          },
        ],
        metadata,
        subscription_data: {
          metadata,
        },
        success_url: successUrl,
        cancel_url: cancelUrl,
      },
      {
        idempotencyKey:
          `checkout:${conversation.conversation_id}:${conversation.discord_user_id}:${plan.key}`,
      }
    );

  upsertStripeCheckoutSession(db, {
    stripeCheckoutSessionId: session.id,
    stripeCustomerId: customer.stripe_customer_id,
    conversationId: conversation.conversation_id,
    guildId: conversation.guild_id,
    discordUserId: conversation.discord_user_id,
    planKey: plan.key,
    stripePriceId: plan.priceId,
    creatorId: conversation.creator_id,
    creatorInviteId: conversation.creator_invite_id,
    creatorInviteCode:
      conversation.creator_invite_code,
    status: session.status || "open",
    url: session.url,
    expiresAt: isoFromStripeTimestamp(
      session.expires_at
    ),
  });

  await interaction.editReply({
    content: buildCheckoutPrompt(plan),
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("Continue to Secure Checkout")
          .setStyle(ButtonStyle.Link)
          .setURL(session.url)
      ),
    ],
  });
}

async function createBillingPortalSession(interaction) {
  const { conversation, allowed } =
    requireBillingConversation(interaction);

  if (!allowed) {
    await interaction.reply({
      content:
        "Only the person who opened this partnership conversation can manage billing.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  await interaction.deferReply({
    flags: MessageFlags.Ephemeral,
  });

  const customer = getStripeCustomerForDiscordUser(
    db,
    conversation.guild_id,
    conversation.discord_user_id
  );

  if (!customer) {
    await interaction.editReply({
      content:
        "No Stripe billing account exists yet. Choose a plan first.",
    });

    return;
  }

  const stripe = getStripeClient();
  const baseUrl = requirePublicBaseUrl();
  const portalSession =
    await stripe.billingPortal.sessions.create({
      customer: customer.stripe_customer_id,
      return_url: `${baseUrl}/stripe/success`,
    });

  await interaction.editReply({
    content:
      `Manage billing: ${portalSession.url}`,
  });
}

async function launchPartnerLinksActivity(interaction) {
  const { allowed } =
    requireBillingConversation(interaction);

  if (!allowed) {
    await interaction.reply({
      content:
        "Only the person who opened this partnership conversation can view plans from here.",
      flags: MessageFlags.Ephemeral,
    });

    return;
  }

  if (typeof interaction.launchActivity === "function") {
    await interaction.launchActivity();
    return;
  }

  await interaction.client.rest.post(
    Routes.interactionCallback(
      interaction.id,
      interaction.token
    ),
    {
      body: {
        type: InteractionResponseType.LaunchActivity,
      },
    }
  );
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

  const archiveRow = new ActionRowBuilder().addComponents(
    archiveButton
  );

  const plansButton = new ButtonBuilder()
    .setCustomId("launch_partnerlinks_activity")
    .setLabel("View PartnerLinks Plans")
    .setStyle(ButtonStyle.Primary);

  const manageBillingButton = new ButtonBuilder()
    .setCustomId("billing_manage")
    .setLabel("Manage Billing")
    .setStyle(ButtonStyle.Secondary);

  const billingRow = new ActionRowBuilder().addComponents(
    plansButton,
    manageBillingButton
  );

  return {
    content: `<@${user.id}> <@&${ADMIN_ROLE_ID}>`,
    embeds: [embed],
    components: [billingRow, archiveRow],
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
        interaction.customId.startsWith(
          "billing_plan:"
        )
      ) {
        const planKey =
          interaction.customId.split(":")[1];
        await createStripeCheckout(
          interaction,
          planKey
        );
        return;
      }

      if (
        interaction.customId ===
        "launch_partnerlinks_activity"
      ) {
        await launchPartnerLinksActivity(interaction);
        return;
      }

      if (
        interaction.customId === "billing_manage"
      ) {
        await createBillingPortalSession(
          interaction
        );
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
// HTTP SERVER / STRIPE WEBHOOKS
// ============================================================

const stripeWebhookRepositories = {
  beginStripeWebhookEvent,
  getStripeCheckoutSession,
  markStripeWebhookEventFailed,
  markStripeWebhookEventProcessed,
  updateStripeCheckoutSessionStatus,
  updateSubscriptionInvoiceStatus,
  upsertBrandSubscription,
  getBrandSubscription,
  getPartnershipConversationById,
  claimStripePaidConfirmation,
  markStripePaidConfirmationSent,
  markStripePaidConfirmationFailed,
};

async function sendPaidSubscriptionConfirmation(
  confirmation
) {
  const channel = await client.channels.fetch(
    confirmation.channelId
  );

  if (
    !channel ||
    channel.type !== ChannelType.GuildText
  ) {
    throw new Error(
      `Partnership channel ${confirmation.channelId} is unavailable.`
    );
  }

  return channel.send({
    content: [
      "✅ **Subscription Active**",
      "",
      `Your ${confirmation.planLabel} plan is now active.`,
      "",
      "We've received your payment and your PartnerLinks onboarding will continue here.",
    ].join("\n"),
  });
}

function sendHttpResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function sendHtmlResponse(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function buildStripeSuccessPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment confirmed | PartnerLinks</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #09090b;
      color: #f4f4f5;
    }

    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: #09090b;
    }

    main {
      width: min(100% - 40px, 560px);
    }

    .brand {
      margin-bottom: 24px;
      color: #a1a1aa;
      font-size: 14px;
      letter-spacing: 0;
    }

    h1 {
      margin: 0 0 16px;
      font-size: 40px;
      line-height: 1.05;
      letter-spacing: 0;
    }

    p {
      margin: 0;
      color: #d4d4d8;
      font-size: 18px;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <main>
    <div class="brand">PartnerLinks</div>
    <h1>Payment confirmed</h1>
    <p>Your PartnerLinks subscription was successfully processed.<br>You can close this window and return to Discord. A confirmation is waiting for you there.</p>
  </main>
</body>
</html>`;
}

function buildBrandsActivityPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PartnerLinks Plans</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #080c0a;
      color: #f3f5f1;
      --page: #080c0a;
      --card-green: #101713;
      --card-gold: #15130f;
      --text: #f4f6f2;
      --body: #c8cec7;
      --muted: #8c948d;
      --line: rgba(229, 232, 221, 0.12);
      --green: #9bc9a7;
      --green-border: rgba(143, 188, 154, 0.5);
      --green-badge: #a8cdb0;
      --gold: #d5bd79;
      --gold-border: rgba(209, 181, 112, 0.55);
      --gold-badge: #d8bf78;
    }

    * {
      box-sizing: border-box;
    }

    html {
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: var(--page);
    }

    body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      display: flex;
      padding: 0;
      background:
        radial-gradient(circle at 50% -20%, rgba(36, 57, 43, 0.32), transparent 42%),
        linear-gradient(180deg, #0b100d 0%, #070908 100%);
    }

    main {
      width: 100%;
      height: 100dvh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding:
        clamp(18px, 3vh, 36px)
        clamp(24px, 4vw, 72px)
        clamp(112px, 14vh, 150px);
    }

    .plans {
      width: 100%;
      max-width: 1760px;
      height: min(100%, 690px);
      max-height: 690px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: clamp(24px, 3vw, 48px);
      align-items: stretch;
    }

    .plan {
      height: 100%;
      min-height: 0;
      display: flex;
      flex-direction: column;
      padding: clamp(24px, 3vw, 44px);
      border: 1px solid var(--accent-border);
      border-radius: 8px;
      background: var(--card-bg);
    }

    .plan.marketplace {
      --accent: var(--green);
      --accent-border: var(--green-border);
      --badge-bg: var(--green-badge);
      --card-bg: var(--card-green);
    }

    .plan.management {
      --accent: var(--gold);
      --accent-border: var(--gold-border);
      --badge-bg: var(--gold-badge);
      --card-bg: var(--card-gold);
    }

    .badge {
      width: fit-content;
      margin-bottom: clamp(16px, 2.3vh, 26px);
      padding: 8px 14px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: #151a14;
      font-size: clamp(11px, 1.05vw, 15px);
      font-weight: 800;
      line-height: 1;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      color: var(--text);
      font-size: clamp(34px, 3vw, 58px);
      line-height: 1.02;
      font-weight: 760;
      letter-spacing: 0;
    }

    .price {
      display: flex;
      align-items: baseline;
      gap: clamp(8px, 1vw, 14px);
      margin-top: clamp(18px, 2.5vh, 30px);
      color: var(--muted);
    }

    .amount {
      color: var(--accent);
      font-size: clamp(56px, 5.4vw, 100px);
      line-height: 0.95;
      font-weight: 780;
      letter-spacing: 0;
    }

    .period {
      font-size: clamp(18px, 1.65vw, 28px);
      font-weight: 600;
    }

    .description {
      min-height: clamp(78px, 9vh, 122px);
      margin: clamp(16px, 2.4vh, 28px) 0 0;
      color: var(--body);
      font-size: clamp(17px, 1.55vw, 26px);
      line-height: 1.42;
    }

    .divider {
      height: 1px;
      margin: clamp(18px, 3vh, 34px) 0 clamp(16px, 2.5vh, 28px);
      background: var(--line);
    }

    ul {
      flex: 1 1 auto;
      min-height: 0;
      display: grid;
      align-content: start;
      gap: clamp(10px, 1.45vh, 18px);
      margin: 0;
      padding: 0;
      list-style: none;
    }

    li {
      display: grid;
      grid-template-columns: clamp(22px, 1.8vw, 30px) 1fr;
      gap: clamp(10px, 1.1vw, 16px);
      align-items: start;
      color: #e6e9e2;
      font-size: clamp(15px, 1.35vw, 23px);
      line-height: 1.28;
    }

    .check {
      width: clamp(22px, 1.8vw, 30px);
      height: clamp(22px, 1.8vw, 30px);
      display: inline-grid;
      place-items: center;
      border-radius: 999px;
      background: var(--accent);
      color: #151a14;
      font-size: clamp(14px, 1.1vw, 18px);
      font-weight: 900;
      line-height: 1;
    }

    .cta {
      flex: 0 0 auto;
      width: 100%;
      height: clamp(52px, 6.2vh, 78px);
      margin-top: clamp(28px, 4vh, 44px);
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: #11150f;
      font: inherit;
      font-size: clamp(16px, 1.45vw, 24px);
      font-weight: 800;
      cursor: pointer;
      transition: filter 150ms ease, transform 150ms ease;
    }

    .cta:hover {
      filter: brightness(1.05);
    }

    .cta:active {
      transform: translateY(1px);
    }

    .cta:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
    }

    @media (max-height: 980px) and (min-width: 801px) {
      body {
        padding: 0;
      }

      main {
        padding:
          clamp(12px, 1.8vh, 20px)
          clamp(24px, 3vw, 56px)
          clamp(34px, 5vh, 58px);
      }

      .plan {
        padding: clamp(18px, 2.2vw, 30px);
      }

      .badge {
        margin-bottom: clamp(10px, 1.2vh, 14px);
        padding: 6px 12px;
        font-size: clamp(10px, 0.82vw, 12px);
      }

      h1 {
        font-size: clamp(28px, 2.45vw, 40px);
      }

      .price {
        margin-top: clamp(8px, 1.2vh, 13px);
      }

      .amount {
        font-size: clamp(44px, 4.2vw, 66px);
      }

      .period {
        font-size: clamp(15px, 1.15vw, 19px);
      }

      .description {
        min-height: clamp(42px, 5.8vh, 58px);
        margin-top: clamp(8px, 1.1vh, 12px);
        font-size: clamp(14px, 1vw, 16px);
        line-height: 1.3;
      }

      .divider {
        margin: clamp(10px, 1.4vh, 14px) 0 clamp(9px, 1.2vh, 12px);
      }

      ul {
        flex: 1 1 auto;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: clamp(6px, 0.85vh, 9px);
      }

      li {
        grid-template-columns: clamp(18px, 1.25vw, 22px) 1fr;
        gap: 9px;
        font-size: clamp(12px, 0.9vw, 14px);
        line-height: 1.18;
      }

      .check {
        width: clamp(18px, 1.25vw, 22px);
        height: clamp(18px, 1.25vw, 22px);
        font-size: clamp(11px, 0.8vw, 13px);
      }

      .cta {
        height: clamp(44px, 5.2vh, 52px);
        margin-top: clamp(20px, 2.6vh, 28px);
        font-size: clamp(13px, 0.95vw, 15px);
      }
    }

    @media (max-height: 760px) and (min-width: 801px) {
      main {
        padding:
          10px
          clamp(18px, 2.4vw, 40px)
          clamp(28px, 5vh, 44px);
      }

      .plans {
        height: 100%;
        gap: clamp(16px, 2.2vw, 32px);
      }

      .plan {
        padding: clamp(18px, 2vw, 28px);
      }

      .badge {
        margin-bottom: 10px;
        padding: 6px 10px;
      }

      h1 {
        font-size: clamp(25px, 2.2vw, 36px);
      }

      .price {
        margin-top: 9px;
      }

      .amount {
        font-size: clamp(38px, 4vw, 60px);
      }

      .period {
        font-size: clamp(14px, 1.1vw, 18px);
      }

      .description {
        min-height: clamp(44px, 6vh, 58px);
        margin-top: 8px;
        font-size: clamp(13px, 0.92vw, 15px);
        line-height: 1.3;
      }

      .divider {
        margin: 10px 0;
      }

      ul {
        flex: 1 1 auto;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: clamp(6px, 0.9vh, 9px);
      }

      li {
        grid-template-columns: 18px 1fr;
        gap: 9px;
        font-size: clamp(12px, 0.82vw, 14px);
      }

      .check {
        width: 18px;
        height: 18px;
        font-size: 11px;
      }

      .cta {
        height: clamp(42px, 5.8vh, 50px);
        margin-top: 20px;
        font-size: clamp(13px, 0.9vw, 15px);
      }
    }

    @media (max-width: 800px) {
      html,
      body {
        min-height: 100%;
        height: auto;
        overflow-x: hidden;
        overflow-y: auto;
      }

      body {
        display: block;
        padding: 0;
      }

      main {
        height: auto;
        min-height: 100dvh;
        padding: 18px 14px 112px;
      }

      .plans {
        height: auto;
        max-height: none;
        grid-template-columns: 1fr;
        gap: 16px;
      }

      .plan {
        height: auto;
        min-height: auto;
        padding: 24px;
      }

      h1 {
        font-size: 28px;
      }

      .amount {
        font-size: 48px;
      }

      .description {
        min-height: auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <section class="plans" aria-label="PartnerLinks subscription plans">
      <article class="plan marketplace">
        <div class="badge">Marketplace</div>
        <h1>Marketplace +<br>Affiliate Access</h1>
        <div class="price">
          <span class="amount">$500</span>
          <span class="period">/ month</span>
        </div>
        <p class="description">Access PartnerLinks' creator marketplace and the tools to build and grow your affiliate program.</p>
        <div class="divider" aria-hidden="true"></div>
        <ul>
          <li><span class="check" aria-hidden="true">✓</span><span>List your products in the PartnerLinks marketplace</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Connect with vetted creators</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Receive creator sample requests</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Launch exclusive creator campaigns</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Access the PartnerLinks creator network</span></li>
        </ul>
        <button class="cta" type="button" data-plan="marketplace_affiliate">Continue to Secure Checkout →</button>
      </article>

      <article class="plan management">
        <div class="badge">Most Popular</div>
        <h1>Marketplace +<br>Management</h1>
        <div class="price">
          <span class="amount">$1,000</span>
          <span class="period">/ month</span>
        </div>
        <p class="description">Everything in Affiliate Access, plus hands-on management from our team to actively grow your affiliate program.</p>
        <div class="divider" aria-hidden="true"></div>
        <ul>
          <li><span class="check" aria-hidden="true">✓</span><span>Everything in Affiliate Access</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Creator sourcing &amp; outreach</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Affiliate recruitment &amp; onboarding</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Campaign strategy &amp; optimization</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Ongoing program management</span></li>
          <li><span class="check" aria-hidden="true">✓</span><span>Dedicated PartnerLinks support</span></li>
        </ul>
        <button class="cta" type="button" data-plan="marketplace_management">Continue to Secure Checkout →</button>
      </article>
    </section>
  </main>

  <script>
    document.querySelectorAll(".cta").forEach((button) => {
      button.addEventListener("click", () => {
        console.log("PartnerLinks plan selected:", button.dataset.plan);
      });
    });
  </script>
</body>
</html>`;
}

function readRawRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;

      if (size > 1024 * 1024) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

async function handleStripeWebhook(request, response) {
  if (
    !STRIPE_WEBHOOK_SECRET ||
    !STRIPE_WEBHOOK_SECRET.trim()
  ) {
    sendHttpResponse(
      response,
      500,
      "STRIPE_WEBHOOK_SECRET is not configured."
    );
    return;
  }

  let rawBody;

  try {
    rawBody = await readRawRequestBody(request);
  } catch (error) {
    sendHttpResponse(response, 413, error.message);
    return;
  }

  const signature =
    request.headers["stripe-signature"];
  let event;

  try {
    event = getStripeClient().webhooks.constructEvent(
      rawBody,
      signature,
      STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    sendHttpResponse(
      response,
      400,
      `Webhook signature verification failed: ${error.message}`
    );
    return;
  }

  if (event.livemode) {
    sendHttpResponse(
      response,
      400,
      "Live Stripe events are disabled for this beta deployment."
    );
    return;
  }

  try {
    const result = processStripeWebhookEvent({
      db,
      event,
      plans: getConfiguredBillingPlans(),
      repositories: stripeWebhookRepositories,
    });

    if (
      result.status ===
      "pending_discord_confirmation"
    ) {
      try {
        const message =
          await sendPaidSubscriptionConfirmation(
            result.paidConfirmation
          );

        completePaidConfirmation({
          db,
          stripeEventId:
            result.paidConfirmation.stripeEventId,
          stripeInvoiceId:
            result.paidConfirmation.stripeInvoiceId,
          discordMessageId: message.id,
          repositories: stripeWebhookRepositories,
        });
      } catch (error) {
        failPaidConfirmation({
          db,
          stripeEventId:
            result.paidConfirmation.stripeEventId,
          stripeInvoiceId:
            result.paidConfirmation.stripeInvoiceId,
          error,
          repositories: stripeWebhookRepositories,
        });

        throw error;
      }
    }

    sendHttpResponse(response, 200, "ok");
  } catch (error) {
    console.error(
      "❌ Stripe webhook processing error:",
      error
    );
    sendHttpResponse(response, 500, error.message);
  }
}

async function handleHttpRequest(request, response) {
  const url = new URL(
    request.url,
    "http://127.0.0.1"
  );

  if (
    request.method === "POST" &&
    url.pathname === "/stripe/webhook"
  ) {
    await handleStripeWebhook(request, response);
    return;
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/" ||
      url.pathname === "/brands")
  ) {
    sendHtmlResponse(
      response,
      200,
      buildBrandsActivityPage()
    );
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/stripe/success"
  ) {
    sendHtmlResponse(
      response,
      200,
      buildStripeSuccessPage()
    );
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/stripe/cancel"
  ) {
    sendHttpResponse(
      response,
      200,
      "Checkout canceled. You can return to Discord."
    );
    return;
  }

  if (
    request.method === "GET" &&
    url.pathname === "/healthz"
  ) {
    sendHttpResponse(response, 200, "ok");
    return;
  }

  sendHttpResponse(response, 404, "not found");
}

function startHttpServer() {
  const port = Number(HTTP_PORT) || 3000;
  const server = http.createServer((request, response) => {
    handleHttpRequest(request, response).catch((error) => {
      console.error("HTTP server error:", error);
      sendHttpResponse(
        response,
        500,
        "internal server error"
      );
    });
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(
      `✅ HTTP server listening on 127.0.0.1:${port}`
    );
  });

  return server;
}

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

startHttpServer();
client.login(DISCORD_TOKEN);
