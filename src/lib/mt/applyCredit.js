/**
 * Apply Mariana Tek credits (ported from email-automations mtCredits).
 * Uses existing MT credit products via POST /credit_transactions when creditId is set.
 */
import { config } from "../../config.js";
import { mtPost } from "./marianatekClient.js";

function getCreditTransactionAmount() {
  return Number(config.mt.rejectionCreditAmount || 1);
}

function getCreditExpiryDays() {
  const n = Number(config.mt.rejectionCreditExpiryDays || 30);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}

function getCreditNote() {
  return String(
    config.mt.rejectionCreditNote ||
      "Co-Pilot application thank-you credit"
  ).trim();
}

function buildCreditTransactionPayload(mtUserId, creditId, note) {
  const expiry = new Date();
  expiry.setUTCDate(expiry.getUTCDate() + getCreditExpiryDays());
  return {
    data: {
      type: "credit_transactions",
      attributes: {
        transaction_amount: getCreditTransactionAmount(),
        expiration_datetime: expiry.toISOString(),
        note,
      },
      relationships: {
        user: {
          data: { type: "users", id: String(mtUserId) },
        },
        credit: {
          data: { type: "credits", id: String(creditId) },
        },
      },
    },
  };
}

/**
 * @param {{ mtUserId: string, mtUserEmail?: string, creditId?: string, note?: string, logContext?: object }} input
 */
export async function applyMtCredit(input) {
  const creditId = String(
    input.creditId || config.mt.rejectionCreditId || ""
  ).trim();
  if (!creditId) {
    throw new Error(
      "Missing rejection credit product id (set COPILOT_REJECTION_MT_CREDIT_ID_NY / _TO, or pass creditId)"
    );
  }
  if (!input.mtUserId) {
    throw new Error("mtUserId is required to apply credit");
  }

  const note = String(input.note || getCreditNote()).trim();
  const endpoint = String(
    config.mt.creditTransactionEndpoint || "/credit_transactions"
  );
  const payload = buildCreditTransactionPayload(input.mtUserId, creditId, note);
  const response = await mtPost(endpoint, payload);

  const creditTransactionId = String(response?.data?.id || "").trim() || null;
  const expirationDatetime =
    String(
      response?.data?.attributes?.expiration_datetime ||
        payload.data.attributes.expiration_datetime ||
        ""
    ).trim() || null;

  console.log(
    JSON.stringify({
      event: "mt_credit_applied",
      source: "copilot_rejection",
      mtUserId: String(input.mtUserId),
      email: input.mtUserEmail || null,
      creditProductId: creditId,
      creditTransactionId,
      expirationDatetime,
      amount: getCreditTransactionAmount(),
      ...(input.logContext || {}),
    })
  );

  return {
    creditProductId: creditId,
    creditTransactionId,
    expirationDatetime,
    amount: getCreditTransactionAmount(),
  };
}
