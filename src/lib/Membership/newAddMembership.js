import axios from "axios";
import membershipProducts from "./membership_products.json" assert { type: "json" };
import { MT_API_BASE_URL, MT_API_KEY, API_HEADERS, TIER_TO_PRODUCT_KEY } from "../coPilotConstants.js";

/**
 * Get product ID from region and tier
 */
function getProductId(region, tier) {
  const normalizedRegion = region.toUpperCase();
  const normalizedTier = tier.toLowerCase();

  const tierKey = TIER_TO_PRODUCT_KEY[normalizedTier];
  if (!tierKey) {
    throw new Error(`Invalid tier: ${tier}. Must be seeker, wayfinder, or luminary`);
  }

  // Find product matching region
  const products = membershipProducts[tierKey];
  if (!products || products.length === 0) {
    throw new Error(`No products found for tier: ${tier}`);
  }

  // Find product for the region (NY or TO)
  const regionSuffix = normalizedRegion === "NY" ? "NY" : "TO";
  const product = products.find((p) =>
    p.attributes.title.includes(regionSuffix)
  );

  if (!product) {
    throw new Error(`No product found for region: ${region}, tier: ${tier}`);
  }

  return product.id;
}

/**
 * Get child product ID from product ID
 */
async function getChildProductId(productId) {
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/api/child_products`,
      {
        headers: { Authorization: `Bearer ${MT_API_KEY}` },
        params: {
          product: productId,
        },
      }
    );

    const childProducts = response.data?.data;
    if (!childProducts || childProducts.length === 0) {
      throw new Error(`No child products found for product ID: ${productId}`);
    }

    // Return the first child product ID
    return childProducts[0].id;
  } catch (error) {
    console.error(
      `Error fetching child product for product ${productId}:`,
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Get partner ID by region
 * Note: This assumes partner IDs are configured or fetched from API
 * You may need to update this based on your partner IDs
 */
async function getPartnerId(region) {
  try {
    const response = await axios.get(`${MT_API_BASE_URL}/api/partners`, {
      headers: { Authorization: `Bearer ${MT_API_KEY}` },
      params: {
        // Filter by region if API supports it
        // You may need to adjust this based on your API structure
      },
    });

    const partners = response.data?.data;
    if (!partners || partners.length === 0) {
      throw new Error("No partners found");
    }

    // Filter partners by region (you may need to adjust this logic)
    // For now, return first partner as placeholder
    // TODO: Implement proper region-based partner lookup
    return partners[0].id;
  } catch (error) {
    console.error("Error fetching partners:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create a cart
 */
async function createCart(userId, partnerId) {
  try {
    const response = await axios.post(
      `${MT_API_BASE_URL}/api/carts`,
      {
        data: {
          type: "carts",
          attributes: {
            fulfillment_partner: String(partnerId),
            status: "Open",
            user: String(userId),
          },
        },
      },
      {
        headers: API_HEADERS,
      }
    );

    const cart = response.data?.data;
    if (!cart || !cart.id) {
      throw new Error("Failed to create cart: No cart ID returned");
    }

    console.log(`✅ Cart created: ${cart.id}`);
    return cart;
  } catch (error) {
    console.error("Error creating cart:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Add product to cart
 */
async function addProductToCart(cartId, productId, childProductId, partnerId) {
  try {
    const response = await axios.post(
      `${MT_API_BASE_URL}/api/carts/${cartId}/add_product`,
      {
        data: {
          type: "cart_add_product",
          attributes: {
            quantity: 1,
            options: [],
            has_options: false,
          },
          relationships: {
            cart: {
              data: {
                type: "carts",
                id: String(cartId),
              },
            },
            partner: {
              data: {
                type: "partners",
                id: String(partnerId),
              },
            },
            product: {
              data: {
                type: "child_products",
                id: String(childProductId),
              },
            },
          },
        },
      },
      {
        headers: API_HEADERS,
      }
    );

    console.log(`✅ Product added to cart: ${cartId}`);
    return response.data?.data;
  } catch (error) {
    console.error(
      "Error adding product to cart:",
      error.response?.data || error.message
    );
    throw error;
  }
}

/**
 * Get cart total amount
 */
async function getCartTotal(cartId) {
  try {
    const response = await axios.get(
      `${MT_API_BASE_URL}/api/carts/${cartId}`,
      {
        headers: { Authorization: `Bearer ${MT_API_KEY}` },
      }
    );

    const cart = response.data?.data;
    const total = cart?.attributes?.total || 0;
    return parseFloat(total);
  } catch (error) {
    console.error("Error getting cart total:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Create checkout with bankcard payment
 */
async function createCheckout(cartId, partnerId, amount, paymentMethodId = "4111") {
  try {
    const response = await axios.post(
      `${MT_API_BASE_URL}/api/checkouts`,
      {
        data: {
          type: "checkouts",
          attributes: {
            payments: [
              {
                amount: amount,
                type: "bankcard",
                id: String(paymentMethodId),
              },
            ],
            status: null,
          },
          relationships: {
            cart: {
              data: {
                type: "carts",
                id: String(cartId),
              },
            },
            for_reservation: {
              data: null,
            },
            originating_partner: {
              data: {
                type: "partners",
                id: String(partnerId),
              },
            },
          },
        },
      },
      {
        headers: API_HEADERS,
      }
    );

    const checkout = response.data?.data;
    console.log(`✅ Checkout created: ${checkout?.id}`);
    return checkout;
  } catch (error) {
    console.error("Error creating checkout:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Add new membership using cart/checkout flow
 * @param {string|number} userId - The user ID
 * @param {string} region - "NY" or "TO"
 * @param {string} tier - "seeker", "wayfinder", or "luminary"
 * @param {string|number} [partnerId] - Optional partner ID. If not provided, will be fetched.
 * @param {string|number} [paymentMethodId] - Optional payment method ID. Defaults to "4111".
 * @returns {Promise<Object|null>} Checkout result or null if failed
 */
export async function addNewMembership(
  userId,
  region,
  tier,
  partnerId = null,
  paymentMethodId = "4111"
) {
  if (!userId) {
    throw new Error("userId is required");
  }

  if (!region || !tier) {
    throw new Error("region and tier are required");
  }

  try {
    console.log(`🚀 Starting membership creation for user ${userId}, region: ${region}, tier: ${tier}`);

    // Step 1: Get product ID from region and tier
    const productId = getProductId(region, tier);
    console.log(`📦 Product ID: ${productId}`);

    // Step 2: Get child product ID
    const childProductId = await getChildProductId(productId);
    console.log(`👶 Child Product ID: ${childProductId}`);

    // Step 3: Get partner ID if not provided
    if (!partnerId) {
      partnerId = await getPartnerId(region);
      console.log(`🏢 Partner ID: ${partnerId}`);
    }

    // Step 4: Create cart
    const cart = await createCart(userId, partnerId);
    const cartId = cart.id;

    // Step 5: Add product to cart
    await addProductToCart(cartId, productId, childProductId, partnerId);

    // Step 6: Get cart total
    const cartTotal = await getCartTotal(cartId);
    console.log(`💰 Cart total: $${cartTotal}`);

    // Step 7: Create checkout with bankcard
    const checkout = await createCheckout(
      cartId,
      partnerId,
      cartTotal,
      paymentMethodId
    );

    console.log(`✅ Membership creation completed successfully!`);
    return {
      cartId,
      checkoutId: checkout?.id,
      cartTotal,
      productId,
      childProductId,
      partnerId,
    };
  } catch (error) {
    console.error(`❌ Error adding membership:`, error.message);
    throw error;
  }
}
