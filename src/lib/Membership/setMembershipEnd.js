import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const MT_API_BASE_URL = process.env.MT_API_BASE_URL;
const MT_API_KEY = process.env.MT_API_KEY;

if (!MT_API_BASE_URL || !MT_API_KEY) {
  throw new Error("Missing MT_API_BASE_URL or MT_API_KEY");
}

export async function setMembershipEnd(membershipInstanceId) {
  if (!membershipInstanceId) {
    console.error("❌ membershipInstanceId is required");
    return null;
  }

  try {
    // First, fetch the membership instance to get required fields
    const getResponse = await axios.get(
      `${MT_API_BASE_URL}/membership_instances/${membershipInstanceId}`,
      {
        headers: {
          Authorization: `Bearer ${MT_API_KEY}`,
        },
      }
    );

    const membership = getResponse.data?.data;
    if (!membership) {
      console.error("⚠️ Could not fetch membership instance");
      return null;
    }

    const attrs = membership.attributes;

    // Extract required fields for terminate endpoint
    // Set cancellation_datetime to now to terminate immediately
    const cancellationDatetime = new Date().toISOString();
    
    // Set payment_interval_length to 0 to end the current interval immediately
    // This should force immediate termination instead of waiting for billing period end
    const terminateData = {
      data: {
        type: "membership_instances",
        id: String(membershipInstanceId),
        attributes: {
          membership: attrs.membership,
          membership_product: attrs.membership_product,
          payment_interval: attrs.payment_interval,
          payment_interval_length: 0, // Set to 0 to end immediately
          renewal_currency: attrs.renewal_currency,
          user: attrs.user,
          cancellation_datetime: cancellationDatetime,
          adjustment_interval_count: 0, // Adjust remaining intervals to 0
        },
      },
    };

    // Now terminate the membership
    const response = await axios.post(
      `${MT_API_BASE_URL}/membership_instances/${membershipInstanceId}/terminate/`,
      terminateData,
      {
        headers: {
          Authorization: `Bearer ${MT_API_KEY}`,
          "Content-Type": "application/vnd.api+json",
        },
      }
    );

    const updated = response.data?.data;

    if (!updated) {
      console.error("⚠️ No data returned from API");
      return null;
    }

    // --- Key logs to verify update ---
    console.log("🔍 Membership update response:");
    console.log({
      id: updated.id,
      status: updated.attributes?.status,
      cancellation_datetime: updated.attributes?.cancellation_datetime,
      end_date: updated.attributes?.end_date,
      scheduled_end_datetime: updated.attributes?.scheduled_end_datetime,
      next_charge_date: updated.attributes?.next_charge_date,
      interval_start_date_display: updated.attributes?.interval_start_date_display,
    });

    console.log(`✅ Membership ${membershipInstanceId} terminated successfully`);

    return updated;
  } catch (error) {
    console.error(
      `❌ Error updating membership instance ${membershipInstanceId}:`,
      error.response?.data || error.message
    );
    return null;
  }
}