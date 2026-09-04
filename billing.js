const PLAN_MARKETPLACE_AFFILIATE =
  "marketplace_affiliate";
const PLAN_MARKETPLACE_MANAGEMENT =
  "marketplace_management";

const PLAN_LABELS = {
  [PLAN_MARKETPLACE_AFFILIATE]:
    "Marketplace + Affiliate Access",
  [PLAN_MARKETPLACE_MANAGEMENT]:
    "Marketplace + Management",
};

function isoFromUnix(timestamp) {
  if (!timestamp) return null;
  return new Date(timestamp * 1000).toISOString();
}

function requireConfigValue(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required Stripe config: ${name}`);
  }

  return String(value).trim();
}

function getBillingPlans(env) {
  return {
    [PLAN_MARKETPLACE_AFFILIATE]: {
      key: PLAN_MARKETPLACE_AFFILIATE,
      label: PLAN_LABELS[PLAN_MARKETPLACE_AFFILIATE],
      amountLabel: "$500/mo",
      priceId: requireConfigValue(
        env.STRIPE_PRICE_MARKETPLACE_AFFILIATE,
        "STRIPE_PRICE_MARKETPLACE_AFFILIATE"
      ),
    },
    [PLAN_MARKETPLACE_MANAGEMENT]: {
      key: PLAN_MARKETPLACE_MANAGEMENT,
      label: PLAN_LABELS[PLAN_MARKETPLACE_MANAGEMENT],
      amountLabel: "$1,000/mo",
      priceId: requireConfigValue(
        env.STRIPE_PRICE_MARKETPLACE_MANAGEMENT,
        "STRIPE_PRICE_MARKETPLACE_MANAGEMENT"
      ),
    },
  };
}

function getPlanByKey(plans, planKey) {
  const plan = plans[planKey];

  if (!plan) {
    throw new Error(`Unknown billing plan: ${planKey}`);
  }

  return plan;
}

function getPlanKeyByPriceId(plans, priceId) {
  for (const plan of Object.values(plans)) {
    if (plan.priceId === priceId) {
      return plan.key;
    }
  }

  return null;
}

function getPlanLabel(planKey) {
  return PLAN_LABELS[planKey] || planKey;
}

function compactMetadata(metadata) {
  const compacted = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (
      value !== null &&
      value !== undefined &&
      String(value).length > 0
    ) {
      compacted[key] = String(value);
    }
  }

  return compacted;
}

function buildBillingMetadata(conversation, planKey) {
  return compactMetadata({
    guild_id: conversation.guild_id,
    discord_user_id: conversation.discord_user_id,
    conversation_id: conversation.conversation_id,
    plan_key: planKey,
    creator_id: conversation.creator_id,
    creator_invite_id: conversation.creator_invite_id,
    creator_invite_code: conversation.creator_invite_code,
  });
}

function metadataValue(metadata, key) {
  if (!metadata) return null;
  return metadata[key] || null;
}

function stripeId(value) {
  if (!value) return null;
  if (typeof value === "string") return value;
  return value.id || null;
}

function firstSubscriptionPriceId(subscription) {
  const item =
    subscription.items &&
    subscription.items.data &&
    subscription.items.data[0];

  return item && item.price ? item.price.id : null;
}

function subscriptionIdFromInvoice(invoice) {
  const subscriptionId = stripeId(invoice.subscription);

  if (subscriptionId) return subscriptionId;

  if (
    invoice.parent &&
    invoice.parent.subscription_details &&
    invoice.parent.subscription_details.subscription
  ) {
    return invoice.parent.subscription_details.subscription;
  }

  return null;
}

function subscriptionFromCheckoutSession({
  session,
  storedSession,
  plans,
}) {
  const metadata = session.metadata || {};
  const stripePriceId =
    storedSession && storedSession.stripe_price_id
      ? storedSession.stripe_price_id
      : null;

  if (!session.subscription || !stripePriceId) {
    return null;
  }

  return {
    stripeSubscriptionId: stripeId(session.subscription),
    stripeCustomerId: stripeId(session.customer),
    conversationId:
      Number(metadataValue(metadata, "conversation_id")) ||
      storedSession.conversation_id,
    guildId:
      metadataValue(metadata, "guild_id") ||
      storedSession.guild_id,
    discordUserId:
      metadataValue(metadata, "discord_user_id") ||
      storedSession.discord_user_id,
    planKey:
      getPlanKeyByPriceId(plans, stripePriceId) ||
      metadataValue(metadata, "plan_key") ||
      storedSession.plan_key,
    stripePriceId,
    creatorId:
      Number(metadataValue(metadata, "creator_id")) ||
      storedSession.creator_id,
    creatorInviteId:
      Number(metadataValue(metadata, "creator_invite_id")) ||
      storedSession.creator_invite_id,
    creatorInviteCode:
      metadataValue(metadata, "creator_invite_code") ||
      storedSession.creator_invite_code,
    status: "checkout_completed",
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    latestInvoiceId:
      stripeId(session.invoice),
    lastPaymentStatus: session.payment_status || null,
  };
}

function subscriptionFromStripeSubscription({
  subscription,
  plans,
}) {
  const metadata = subscription.metadata || {};
  const stripePriceId =
    firstSubscriptionPriceId(subscription);

  return {
    stripeSubscriptionId: subscription.id,
    stripeCustomerId: stripeId(subscription.customer),
    conversationId:
      Number(metadataValue(metadata, "conversation_id")) ||
      null,
    guildId: metadataValue(metadata, "guild_id"),
    discordUserId:
      metadataValue(metadata, "discord_user_id"),
    planKey:
      getPlanKeyByPriceId(plans, stripePriceId) ||
      metadataValue(metadata, "plan_key"),
    stripePriceId,
    creatorId:
      Number(metadataValue(metadata, "creator_id")) ||
      null,
    creatorInviteId:
      Number(metadataValue(metadata, "creator_invite_id")) ||
      null,
    creatorInviteCode:
      metadataValue(metadata, "creator_invite_code"),
    status: subscription.status,
    currentPeriodStart: isoFromUnix(
      subscription.current_period_start
    ),
    currentPeriodEnd: isoFromUnix(
      subscription.current_period_end
    ),
    cancelAtPeriodEnd:
      Boolean(subscription.cancel_at_period_end),
    canceledAt: isoFromUnix(subscription.canceled_at),
    latestInvoiceId:
      stripeId(subscription.latest_invoice),
    lastPaymentStatus: null,
  };
}

function validateSubscriptionRecord(subscription) {
  const missing = [];

  for (const key of [
    "stripeSubscriptionId",
    "stripeCustomerId",
    "guildId",
    "discordUserId",
    "status",
  ]) {
    if (!subscription[key]) {
      missing.push(key);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `Subscription event missing required metadata: ${missing.join(", ")}`
    );
  }
}

function processStripeWebhookEvent({
  db,
  event,
  plans,
  repositories,
}) {
  const started =
    repositories.beginStripeWebhookEvent(db, {
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      createdAt: isoFromUnix(event.created),
    });

  if (started.alreadyProcessed) {
    return {
      status: "already_processed",
    };
  }

  try {
    db.exec("BEGIN");

    const object = event.data.object;
    let paidConfirmation = null;

    if (event.type === "checkout.session.completed") {
      repositories.updateStripeCheckoutSessionStatus(db, {
        stripeCheckoutSessionId: object.id,
        stripeCustomerId: object.customer,
        status: object.status || "complete",
      });

      const storedSession =
        repositories.getStripeCheckoutSession(db, object.id);
      const subscription =
        storedSession &&
        subscriptionFromCheckoutSession({
          session: object,
          storedSession,
          plans,
        });

      if (subscription) {
        validateSubscriptionRecord(subscription);
        repositories.upsertBrandSubscription(
          db,
          subscription
        );
      }
    } else if (event.type === "checkout.session.expired") {
      repositories.updateStripeCheckoutSessionStatus(db, {
        stripeCheckoutSessionId: object.id,
        stripeCustomerId: object.customer,
        status: "expired",
      });
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const subscription =
        subscriptionFromStripeSubscription({
          subscription: object,
          plans,
        });

      validateSubscriptionRecord(subscription);
      repositories.upsertBrandSubscription(
        db,
        subscription
      );
    } else if (event.type === "invoice.paid") {
      const stripeSubscriptionId =
        subscriptionIdFromInvoice(object);

      if (!stripeSubscriptionId) {
        throw new Error(
          "Paid invoice missing Stripe subscription id."
        );
      }

      repositories.updateSubscriptionInvoiceStatus(db, {
        stripeSubscriptionId,
        latestInvoiceId: object.id,
        lastPaymentStatus: "paid",
      });

      const subscription =
        repositories.getBrandSubscription(
          db,
          stripeSubscriptionId
        );

      if (!subscription) {
        throw new Error(
          `No local subscription found for paid invoice ${object.id}.`
        );
      }

      if (subscription.status !== "active") {
        throw new Error(
          `Paid invoice ${object.id} is for non-active subscription ${subscription.status}.`
        );
      }

      if (!subscription.conversation_id) {
        throw new Error(
          `No conversation id stored for paid invoice ${object.id}.`
        );
      }

      const conversation =
        repositories.getPartnershipConversationById(
          db,
          subscription.conversation_id
        );

      if (!conversation || !conversation.channel_id) {
        throw new Error(
          `No partnership channel mapping found for paid invoice ${object.id}.`
        );
      }

      const claimed =
        repositories.claimStripePaidConfirmation(db, {
          stripeInvoiceId: object.id,
          stripeSubscriptionId,
          conversationId:
            subscription.conversation_id,
          channelId: conversation.channel_id,
          planKey: subscription.plan_key,
        });

      if (claimed.claimed) {
        paidConfirmation = {
          stripeEventId: event.id,
          stripeInvoiceId: object.id,
          stripeSubscriptionId,
          channelId: conversation.channel_id,
          planKey: subscription.plan_key,
          planLabel: getPlanLabel(subscription.plan_key),
        };
      } else if (
        claimed.notification &&
        claimed.notification.status === "sending"
      ) {
        db.exec("COMMIT");

        return {
          status: "confirmation_in_progress",
        };
      }
    } else if (event.type === "invoice.payment_failed") {
      const stripeSubscriptionId =
        subscriptionIdFromInvoice(object);

      if (stripeSubscriptionId) {
        repositories.updateSubscriptionInvoiceStatus(db, {
          stripeSubscriptionId,
          latestInvoiceId: object.id,
          lastPaymentStatus: "payment_failed",
        });
      }
    }

    if (paidConfirmation) {
      db.exec("COMMIT");

      return {
        status: "pending_discord_confirmation",
        paidConfirmation,
      };
    }

    repositories.markStripeWebhookEventProcessed(
      db,
      event.id
    );
    db.exec("COMMIT");

    return {
      status: "processed",
    };
  } catch (error) {
    db.exec("ROLLBACK");
    repositories.markStripeWebhookEventFailed(
      db,
      event.id,
      error
    );
    throw error;
  }
}

function completePaidConfirmation({
  db,
  stripeEventId,
  stripeInvoiceId,
  discordMessageId,
  repositories,
}) {
  db.exec("BEGIN");

  try {
    repositories.markStripePaidConfirmationSent(db, {
      stripeInvoiceId,
      discordMessageId,
    });
    repositories.markStripeWebhookEventProcessed(
      db,
      stripeEventId
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function failPaidConfirmation({
  db,
  stripeEventId,
  stripeInvoiceId,
  error,
  repositories,
}) {
  db.exec("BEGIN");

  try {
    repositories.markStripePaidConfirmationFailed(db, {
      stripeInvoiceId,
      error,
    });
    repositories.markStripeWebhookEventFailed(
      db,
      stripeEventId,
      error
    );
    db.exec("COMMIT");
  } catch (secondaryError) {
    db.exec("ROLLBACK");
    throw secondaryError;
  }
}

module.exports = {
  PLAN_MARKETPLACE_AFFILIATE,
  PLAN_MARKETPLACE_MANAGEMENT,
  buildBillingMetadata,
  completePaidConfirmation,
  failPaidConfirmation,
  getBillingPlans,
  getPlanByKey,
  getPlanKeyByPriceId,
  getPlanLabel,
  processStripeWebhookEvent,
  subscriptionFromStripeSubscription,
};
