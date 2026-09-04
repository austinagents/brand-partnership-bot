const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function chainableBuilder() {
  return class {
    setCustomId() {
      return this;
    }

    setLabel() {
      return this;
    }

    setEmoji() {
      return this;
    }

    setStyle() {
      return this;
    }

    setURL() {
      return this;
    }

    setDisabled() {
      return this;
    }

    setTitle() {
      return this;
    }

    setDescription() {
      return this;
    }

    addComponents() {
      return this;
    }
  };
}

function fakeDiscordModule() {
  class FakeClient {
    constructor() {
      this.user = {
        id: "bot-user",
        tag: "Bot#0000",
      };
      this.channels = {
        fetch: async () => null,
      };
      this.guilds = {
        fetch: async () => null,
      };
    }

    on() {
      return this;
    }

    once() {
      return this;
    }

    login() {
      return Promise.resolve();
    }
  }

  return {
    Client: FakeClient,
    Events: {
      ClientReady: "ready",
      InteractionCreate: "interactionCreate",
      GuildMemberAdd: "guildMemberAdd",
      InviteCreate: "inviteCreate",
      InviteDelete: "inviteDelete",
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      GuildMembers: 4,
      GuildInvites: 8,
    },
    ChannelType: {
      GuildCategory: 4,
      GuildText: 0,
    },
    PermissionFlagsBits: {
      ViewChannel: 1n,
      SendMessages: 2n,
      ReadMessageHistory: 4n,
      AttachFiles: 8n,
      EmbedLinks: 16n,
      ManageMessages: 32n,
      ManageChannels: 64n,
      AddReactions: 128n,
      UseExternalEmojis: 256n,
      Administrator: 512n,
    },
    ButtonBuilder: chainableBuilder(),
    ActionRowBuilder: chainableBuilder(),
    EmbedBuilder: chainableBuilder(),
    ButtonStyle: {
      Primary: 1,
      Secondary: 2,
      Link: 5,
    },
    MessageFlags: {
      Ephemeral: 64,
    },
  };
}

test("index module loads with startup side effects stubbed", () => {
  const previousEnv = { ...process.env };
  const originalLoad = Module._load;
  const databasePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "brand-bot-startup-")),
    "startup.sqlite"
  );
  const server = {
    listen(port, host, callback) {
      if (callback) callback();
      return this;
    },
  };

  process.env = {
    ...process.env,
    DISCORD_TOKEN: "test-token",
    GUILD_ID: "guild-1",
    WORK_WITH_US_CHANNEL_ID: "work-channel",
    ADMIN_ROLE_ID: "admin-role",
    SQLITE_DATABASE_PATH: databasePath,
    HTTP_PORT: "0",
    STRIPE_PRICE_MARKETPLACE_AFFILIATE:
      "price_affiliate",
    STRIPE_PRICE_MARKETPLACE_MANAGEMENT:
      "price_management",
  };

  Module._load = function load(request, parent, isMain) {
    if (request === "discord.js") {
      return fakeDiscordModule();
    }

    if (request === "stripe") {
      return class FakeStripe {};
    }

    if (request === "http" || request === "node:http") {
      return {
        createServer() {
          return server;
        },
      };
    }

    return originalLoad.call(
      this,
      request,
      parent,
      isMain
    );
  };

  try {
    delete require.cache[require.resolve("../index")];
    assert.doesNotThrow(() => {
      require("../index");
    });
  } finally {
    delete require.cache[require.resolve("../index")];
    delete require.cache[require.resolve("../database")];
    Module._load = originalLoad;
    process.env = previousEnv;
  }
});
