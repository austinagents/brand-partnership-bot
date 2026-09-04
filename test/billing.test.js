const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  getBillingPlans,
  getPlanKeyByPriceId,
  processStripeWebhookEvent,
  subscriptionFromStripeSubscription,
} = require("../billing");

function loadDatabaseModule(databasePath) {
  process.env.SQLITE_DATABASE_PATH = databasePath;
  delete require.cache[require.resolve("../database")];
  return require("../database");
}

function openTestDatabase() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "brand-bot-billing-")
  );
  const databasePath = path.join(dir, "test.sqlite");
  const dbm = loadDatabaseModule(databasePath);
  return {
    dbm,
    db: dbm.openDatabase(),
  };
}

function testPlans() {
  return getBillingPlans({
    STRIPE_PRICE_MARKETPLACE_AFFILIATE:
      "price_affiliate",
    STRIPE_PRICE_MARKETPLACE_MANAGEMENT:
      "price_management",
  });
}

function repositories(dbm) {
  return {
    beginStripeWebhookEvent:
      dbm.beginStripeWebhookEvent,
    getStripeCheckoutSession:
      dbm.getStripeCheckoutSession,
    markStripeWebhookEventFailed:
      dbm.markStripeWebhookEventFailed,
    markStripeWebhookEventProcessed:
      dbm.markStripeWebhookEventProcessed,
    updateStripeCheckoutSessionStatus:
      dbm.updateStripeCheckoutSessionStatus,
    updateSubscriptionInvoiceStatus:
      dbm.updateSubscriptionInvoiceStatus,
    upsertBrandSubscription:
      dbm.upsertBrandSubscription,
  };
}

function subscriptionEvent(id = "evt_subscription") {
  return {
    id,
    type: "customer.subscription.updated",
    livemode: false,
    created: 1798848000,
    data: {
      object: {
        id: "sub_123",
        customer: "cus_123",
        status: "active",
        metadata: {
          guild_id: "guild_1",
          discord_user_id: "user_1",
          conversation_id: "42",
          plan_key: "marketplace_affiliate",
        },
        items: {
          data: [
            {
              price: {
                id: "price_management",
              },
            },
          ],
        },
        current_period_start: 1798848000,
        current_period_end: 1801526400,
        cancel_at_period_end: false,
        canceled_at: null,
        latest_invoice: "in_123",
      },
    },
  };
}

test("maps configured Stripe prices to internal plan keys", () => {
  const plans = testPlans();

  assert.equal(
    getPlanKeyByPriceId(plans, "price_affiliate"),
    "marketplace_affiliate"
  );
  assert.equal(
    getPlanKeyByPriceId(plans, "price_management"),
    "marketplace_management"
  );
  assert.equal(
    getPlanKeyByPriceId(plans, "price_unknown"),
    null
  );
});

test("subscription plan_key follows Stripe price after portal plan switch", () => {
  const subscription =
    subscriptionFromStripeSubscription({
      subscription: subscriptionEvent().data.object,
      plans: testPlans(),
    });

  assert.equal(
    subscription.planKey,
    "marketplace_management"
  );
  assert.equal(
    subscription.stripePriceId,
    "price_management"
  );
});

test("reuses one Stripe customer per guild and Discord user", () => {
  const { dbm, db } = openTestDatabase();

  dbm.saveStripeCustomer(db, {
    guildId: "guild_1",
    discordUserId: "user_1",
    stripeCustomerId: "cus_123",
  });

  dbm.saveStripeCustomer(db, {
    guildId: "guild_1",
    discordUserId: "user_1",
    stripeCustomerId: "cus_other",
  });

  const rows = db
    .prepare("SELECT COUNT(*) AS count FROM stripe_customers")
    .get();
  const customer = dbm.getStripeCustomerForDiscordUser(
    db,
    "guild_1",
    "user_1"
  );

  assert.equal(rows.count, 1);
  assert.equal(customer.stripe_customer_id, "cus_123");

  db.close();
});

test("webhook processing is idempotent by Stripe event id", () => {
  const { dbm, db } = openTestDatabase();

  dbm.upsertPartnershipConversation(db, {
    conversationId: 42,
    channelId: "channel_1",
    guildId: "guild_1",
    discordUserId: "user_1",
    creatorId: null,
    creatorInviteId: null,
    creatorInviteCode: null,
    status: "active",
    createdAt: new Date().toISOString(),
  });

  const first = processStripeWebhookEvent({
    db,
    event: subscriptionEvent(),
    plans: testPlans(),
    repositories: repositories(dbm),
  });

  const second = processStripeWebhookEvent({
    db,
    event: subscriptionEvent(),
    plans: testPlans(),
    repositories: repositories(dbm),
  });

  const subscriptions = db
    .prepare(
      "SELECT COUNT(*) AS count FROM brand_subscriptions"
    )
    .get();
  const events = db
    .prepare(
      "SELECT COUNT(*) AS count FROM stripe_webhook_events"
    )
    .get();

  assert.equal(first.status, "processed");
  assert.equal(second.status, "already_processed");
  assert.equal(subscriptions.count, 1);
  assert.equal(events.count, 1);

  db.close();
});

test("checkout completion persists initial subscription snapshot", () => {
  const { dbm, db } = openTestDatabase();

  dbm.upsertPartnershipConversation(db, {
    conversationId: 42,
    channelId: "channel_1",
    guildId: "guild_1",
    discordUserId: "user_1",
    creatorId: null,
    creatorInviteId: null,
    creatorInviteCode: null,
    status: "active",
    createdAt: new Date().toISOString(),
  });

  dbm.upsertStripeCheckoutSession(db, {
    stripeCheckoutSessionId: "cs_123",
    stripeCustomerId: "cus_123",
    conversationId: 42,
    guildId: "guild_1",
    discordUserId: "user_1",
    planKey: "marketplace_affiliate",
    stripePriceId: "price_affiliate",
    creatorId: null,
    creatorInviteId: null,
    creatorInviteCode: null,
    status: "open",
    url: "https://checkout.stripe.com/test",
    expiresAt: null,
  });

  const result = processStripeWebhookEvent({
    db,
    event: {
      id: "evt_checkout",
      type: "checkout.session.completed",
      livemode: false,
      created: 1798848000,
      data: {
        object: {
          id: "cs_123",
          status: "complete",
          customer: "cus_123",
          subscription: "sub_123",
          invoice: "in_123",
          payment_status: "paid",
          metadata: {
            guild_id: "guild_1",
            discord_user_id: "user_1",
            conversation_id: "42",
            plan_key: "marketplace_affiliate",
          },
        },
      },
    },
    plans: testPlans(),
    repositories: repositories(dbm),
  });

  const subscription = db
    .prepare(`
      SELECT status, plan_key, last_payment_status
      FROM brand_subscriptions
      WHERE stripe_subscription_id = ?
    `)
    .get("sub_123");
  const checkout = dbm.getStripeCheckoutSession(
    db,
    "cs_123"
  );

  assert.equal(result.status, "processed");
  assert.equal(checkout.status, "complete");
  assert.equal(
    subscription.status,
    "checkout_completed"
  );
  assert.equal(
    subscription.plan_key,
    "marketplace_affiliate"
  );
  assert.equal(subscription.last_payment_status, "paid");

  db.close();
});

test("invoice events update subscription payment state", () => {
  const { dbm, db } = openTestDatabase();

  dbm.upsertPartnershipConversation(db, {
    conversationId: 42,
    channelId: "channel_1",
    guildId: "guild_1",
    discordUserId: "user_1",
    creatorId: null,
    creatorInviteId: null,
    creatorInviteCode: null,
    status: "active",
    createdAt: new Date().toISOString(),
  });

  processStripeWebhookEvent({
    db,
    event: subscriptionEvent("evt_subscription_first"),
    plans: testPlans(),
    repositories: repositories(dbm),
  });

  processStripeWebhookEvent({
    db,
    event: {
      id: "evt_invoice_failed",
      type: "invoice.payment_failed",
      livemode: false,
      created: 1798848000,
      data: {
        object: {
          id: "in_failed",
          subscription: "sub_123",
        },
      },
    },
    plans: testPlans(),
    repositories: repositories(dbm),
  });

  const subscription = db
    .prepare(`
      SELECT latest_invoice_id, last_payment_status
      FROM brand_subscriptions
      WHERE stripe_subscription_id = ?
    `)
    .get("sub_123");

  assert.equal(subscription.latest_invoice_id, "in_failed");
  assert.equal(
    subscription.last_payment_status,
    "payment_failed"
  );

  db.close();
});

test("webhook failure records processing error for retry", () => {
  const { dbm, db } = openTestDatabase();
  const event = subscriptionEvent("evt_failure");

  event.data.object.metadata = {};

  assert.throws(() => {
    processStripeWebhookEvent({
      db,
      event,
      plans: testPlans(),
      repositories: repositories(dbm),
    });
  }, /missing required metadata/);

  const row = db
    .prepare(`
      SELECT processed_at, processing_error
      FROM stripe_webhook_events
      WHERE stripe_event_id = ?
    `)
    .get("evt_failure");

  assert.equal(row.processed_at, null);
  assert.match(
    row.processing_error,
    /missing required metadata/
  );

  db.close();
});
