import "dotenv/config";
import fs from "fs";
import { API_HEADERS, MT_API_BASE_URL } from "../../coPilotConstants.js";
import {
  getValidBankcardId,
  hasValidBankcardOnFile,
} from "../../mt/bankcards.js";
import {
  getCartTotal,
  prepareCartForMembership,
  restoreParkedCartItems,
} from "../../mt/cartHelpers.js";
import { mtPost } from "../../mt/marianatekClient.js";

const REQUEST_DELAY_MS = Number(process.env.REQUEST_DELAY_MS || 100);
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const OUTPUT_LOG = process.env.OUTPUT_LOG || "membership_log.json";
const OUTPUT_SUMMARY = process.env.OUTPUT_SUMMARY || "membership_summary.txt";

const LOCATION_TO_PARTNER = {
  48717: "41362", // Adelaide
  48750: "41395", // Yorkville
  48784: "41429", // Flatiron
  48817: "41462", // Williamsburg
};

const LOCATION_TO_REGION = {
  48717: "TO",
  48750: "TO",
  48784: "NY",
  48817: "NY",
};

const SEEKER_CHILD_PRODUCT_MEMBERSHIPS = {
  TO: "17074",
  NY: "17076",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadEmails({ emailsEnv = "", emailsFile = null, cliEmails = [] } = {}) {
  const list = [];

  if (emailsFile && fs.existsSync(emailsFile)) {
    const content = fs.readFileSync(emailsFile, "utf8");
    content
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith("#") && line.includes("@"))
      .forEach((email) => list.push(email));
  }

  if (emailsEnv) {
    emailsEnv
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s.includes("@"))
      .forEach((email) => list.push(email));
  }

  cliEmails.forEach((email) => {
    const normalized = String(email).trim().toLowerCase();
    if (normalized && normalized.includes("@")) {
      list.push(normalized);
    }
  });

  return [...new Set(list)];
}

async function mtFetch(path, { method = "GET", body } = {}) {
  const response = await fetch(`${MT_API_BASE_URL}${path}`, {
    method,
    headers: API_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    const detail =
      typeof data === "string"
        ? data.slice(0, 200)
        : JSON.stringify(data?.errors ?? data).slice(0, 300);
    throw new Error(`${method} ${path} failed (${response.status}): ${detail}`);
  }

  return data;
}

async function findUserByEmail(email) {
  const data = await mtFetch(`/users?email=${encodeURIComponent(email)}`);
  return data?.data?.[0] ?? null;
}

function getClassCount(user) {
  const count = user?.attributes?.completed_class_count;
  return typeof count === "number" ? count : null;
}

function getHomeLocationId(user) {
  const homeLocationData =
    user?.relationships?.home_location?.data ||
    user?.attributes?.home_location?.data ||
    null;
  const location = Array.isArray(homeLocationData)
    ? homeLocationData[0]
    : homeLocationData;
  return location?.id ? String(location.id) : null;
}

function resolveRegionAndPartner(user) {
  const locationId = getHomeLocationId(user);
  if (!locationId) {
    return { region: null, partnerId: null, locationId: null };
  }

  return {
    region: LOCATION_TO_REGION[locationId] ?? null,
    partnerId: LOCATION_TO_PARTNER[locationId] ?? null,
    locationId,
  };
}

async function assignSeekerMembership(userId, region, partnerId, paymentMethodId) {
  const childProductMembershipId = SEEKER_CHILD_PRODUCT_MEMBERSHIPS[region];
  if (!childProductMembershipId) {
    throw new Error(`No Seeker membership product configured for region ${region}`);
  }

  const { cartId, created, membershipAdded, parked } = await prepareCartForMembership({
    userId,
    partnerId,
    membershipProductId: childProductMembershipId,
    productType: "child_product_memberships",
  });

  const amount = await getCartTotal(cartId);

  let checkoutData;
  try {
    checkoutData = await mtPost("/checkouts", {
      data: {
        type: "checkouts",
        attributes: {
          payments: [
            {
              amount,
              type: "bankcard",
              id: String(paymentMethodId),
            },
          ],
          status: null,
        },
        relationships: {
          cart: { data: { type: "carts", id: String(cartId) } },
          for_reservation: { data: null },
          originating_partner: {
            data: { type: "partners", id: String(partnerId) },
          },
        },
      },
    });
  } catch (error) {
    if (parked?.length) {
      try {
        await restoreParkedCartItems({ userId, partnerId, parked });
      } catch (restoreError) {
        console.warn(
          `   ⚠️  Failed to restore parked cart items after membership error: ${restoreError.message}`
        );
      }
    }
    throw error;
  }

  if (parked?.length) {
    try {
      await restoreParkedCartItems({ userId, partnerId, parked });
    } catch (error) {
      console.warn(
        `   ⚠️  Membership assigned but failed to restore parked cart items: ${error.message}`
      );
    }
  }

  return {
    cartId: String(cartId),
    checkoutId: checkoutData?.data?.id ?? null,
    amount,
    childProductMembershipId,
    paymentMethodId: String(paymentMethodId),
    cartCreated: created,
    membershipAdded,
  };
}

export async function assignMembershipsToUsers(options = {}) {
  const emails = loadEmails(options);

  if (emails.length === 0) {
    throw new Error(
      "No emails provided. Use EMAILS, EMAILS_FILE, or pass emails as CLI args."
    );
  }

  console.log(`🚀 Assigning Seeker memberships for ${emails.length} email(s)`);
  if (DRY_RUN) {
    console.log("   DRY RUN: no memberships will be created\n");
  } else {
    console.log("");
  }

  const results = {
    dryRun: DRY_RUN,
    success: [],
    failed: [],
    notFound: [],
    skipped: [],
  };

  for (const email of emails) {
    console.log(`🔍 Looking up: ${email}`);

    try {
      const user = await findUserByEmail(email);
      await sleep(REQUEST_DELAY_MS);

      if (!user) {
        console.log("   ⚠️ No MT account found");
        results.notFound.push(email);
        continue;
      }

      const userId = user.id;
      const classCount = getClassCount(user);
      const { region, partnerId, locationId } = resolveRegionAndPartner(user);

      console.log(`   ✅ Account ID: ${userId}`);
      console.log(`   📊 Class count: ${classCount ?? "unknown"}`);

      if (!region || !partnerId) {
        console.log("   ⚠️ Could not determine region/partner from home studio");
        results.skipped.push({
          email,
          userId,
          classCount,
          locationId,
          reason: "missing_region_or_partner",
        });
        continue;
      }

      const membershipTitle = `Seeker ${region} Co-Pilot Membership`;
      console.log(`   📍 Region: ${region}, partner: ${partnerId}`);

      const hasCc = await hasValidBankcardOnFile(userId);
      await sleep(REQUEST_DELAY_MS);
      console.log(`   💳 CC on file: ${hasCc ? "yes" : "no"}`);

      if (!hasCc) {
        console.log("   ⚠️ Skipping — no valid bankcard on file");
        results.skipped.push({
          email,
          userId,
          classCount,
          region,
          partnerId,
          locationId,
          reason: "no_cc_on_file",
        });
        continue;
      }

      if (DRY_RUN) {
        results.success.push({
          email,
          userId,
          classCount,
          region,
          partnerId,
          membership: membershipTitle,
          dryRun: true,
        });
        continue;
      }

      const paymentMethodId = await getValidBankcardId(userId);
      if (!paymentMethodId) {
        console.log("   ⚠️ Skipping — could not resolve bankcard ID");
        results.skipped.push({
          email,
          userId,
          classCount,
          region,
          partnerId,
          locationId,
          reason: "no_cc_on_file",
        });
        continue;
      }

      const assignment = await assignSeekerMembership(
        userId,
        region,
        partnerId,
        paymentMethodId,
      );
      await sleep(REQUEST_DELAY_MS);

      console.log(`   ✅ Assigned ${membershipTitle}`);
      results.success.push({
        email,
        userId,
        classCount,
        region,
        partnerId,
        membership: membershipTitle,
        ...assignment,
      });
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      results.failed.push({ email, error: error.message });
    }

    await sleep(REQUEST_DELAY_MS);
  }

  fs.writeFileSync(OUTPUT_LOG, JSON.stringify(results, null, 2));

  const summary = [
    "===== Membership Assignment Summary =====",
    DRY_RUN ? "(DRY RUN — no memberships created)" : "",
    "\n✅ Success:",
    results.success
      .map(
        (s) =>
          `${s.email} (${s.membership}) user=${s.userId} classes=${s.classCount ?? "?"}`
      )
      .join("\n") || "None",
    "\nNot Found:",
    results.notFound.join("\n") || "None",
    "\nSkipped:",
    results.skipped
      .map((s) => `${s.email} — ${s.reason}`)
      .join("\n") || "None",
    "\nFailed:",
    results.failed
      .map((f) => `${f.email} — ${f.error}`)
      .join("\n") || "None",
  ]
    .filter(Boolean)
    .join("\n");

  fs.writeFileSync(OUTPUT_SUMMARY, summary);

  console.log("\n✅ Job completed:");
  console.log(`   ✅ Success: ${results.success.length}`);
  console.log(`   ⚠️ Not found: ${results.notFound.length}`);
  console.log(`   ⏭️ Skipped: ${results.skipped.length}`);
  console.log(`   ❌ Failed: ${results.failed.length}`);
  console.log(`\n📄 ${OUTPUT_LOG}`);
  console.log(`📄 ${OUTPUT_SUMMARY}`);

  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assignMembershipsToUsers()
    .then(() => console.log("Finished assigning memberships!"))
    .catch((err) => {
      console.error("Script failed:", err);
      process.exit(1);
    });
}
