const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

async function requestHandler(handler, options) {
  return new Promise((resolve, reject) => {
    const request = {
      method: options.method || "GET",
      url: options.url,
      headers: options.headers || {},
    };
    const response = {
      statusCode: null,
      headers: null,
      body: "",
      writeHead(statusCode, headers) {
        this.statusCode = statusCode;
        this.headers = headers;
      },
      end(body) {
        this.body = body || "";
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: this.body,
        });
      },
    };

    Promise.resolve(handler(request, response)).catch(reject);
  });
}

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

test("HTTP routes serve Activity UI and preserve existing endpoints", async () => {
  const previousEnv = { ...process.env };
  const originalLoad = Module._load;
  const databasePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "brand-bot-routes-")),
    "routes.sqlite"
  );
  let capturedHandler = null;
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
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
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
        createServer(handler) {
          capturedHandler = handler;
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
    require("../index");

    assert.equal(typeof capturedHandler, "function");

    const root = await requestHandler(capturedHandler, {
      url: "/",
    });
    assert.equal(root.statusCode, 200);
    assert.match(
      root.headers["Content-Type"],
      /text\/html/
    );
    assert.match(root.body, /PartnerLinks Plans/);
    assert.match(root.body, /Marketplace \+/);
    assert.match(root.body, /\$1,000/);

    const brands = await requestHandler(capturedHandler, {
      url: "/brands",
    });
    assert.equal(brands.statusCode, 200);
    assert.match(brands.body, /PartnerLinks Plans/);
    assert.match(
      brands.body,
      /Continue to Secure Checkout/
    );

    const healthz = await requestHandler(capturedHandler, {
      url: "/healthz",
    });
    assert.equal(healthz.statusCode, 200);
    assert.equal(healthz.body, "ok");

    const success = await requestHandler(capturedHandler, {
      url: "/stripe/success",
    });
    assert.equal(success.statusCode, 200);
    assert.match(success.body, /Payment confirmed/);

    const cancel = await requestHandler(capturedHandler, {
      url: "/stripe/cancel",
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(
      cancel.body,
      "Checkout canceled. You can return to Discord."
    );

    const webhook = await requestHandler(capturedHandler, {
      method: "POST",
      url: "/stripe/webhook",
    });
    assert.equal(webhook.statusCode, 500);
    assert.equal(
      webhook.body,
      "STRIPE_WEBHOOK_SECRET is not configured."
    );
  } finally {
    delete require.cache[require.resolve("../index")];
    delete require.cache[require.resolve("../database")];
    Module._load = originalLoad;
    process.env = previousEnv;
  }
});
