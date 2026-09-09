import { mtGet, mtPost, mtPatch } from "./marianatekClient.js";

export function getCartPartnerId(cart) {
  return String(cart?.relationships?.fulfillment_partner?.data?.id ?? "");
}

export async function listOpenCartsForUser(userId) {
  const response = await mtGet("/carts", {
    user: String(userId),
    status: "Open",
  });
  return response?.data ?? [];
}

export async function findOpenCartForPartner(userId, partnerId) {
  const partner = String(partnerId);
  const carts = await listOpenCartsForUser(userId);
  return carts.find((cart) => getCartPartnerId(cart) === partner) ?? null;
}

export async function getCartLines(cartId) {
  const response = await mtGet("/cart_lines", { cart: String(cartId) });
  const data = response?.data;
  return Array.isArray(data) ? data : data ? [data] : [];
}

function lineQuantity(line) {
  const n = Number(line?.attributes?.quantity);
  return Number.isFinite(n) ? n : 0;
}

export function getLineProductId(line) {
  return String(line?.relationships?.product?.data?.id ?? "");
}

export async function cartContainsProduct(cartId, productId) {
  const target = String(productId);
  const lines = await getCartLines(cartId);
  return lines.some(
    (line) => getLineProductId(line) === target && lineQuantity(line) > 0
  );
}

export async function assertCartHasOnlyAllowedProducts(cartId, allowedProductIds) {
  const allowed = new Set(allowedProductIds.map(String));
  const lines = await getCartLines(cartId);
  const foreign = lines.filter(
    (line) => lineQuantity(line) > 0 && !allowed.has(getLineProductId(line))
  );

  if (foreign.length > 0) {
    const ids = foreign.map(getLineProductId).join(", ");
    throw new Error(
      `Open cart ${cartId} already contains other product(s): ${ids}. Clear the cart before assigning a membership.`,
    );
  }
}

export async function createCart(userId, partnerId) {
  const result = await mtPost("/carts", {
    data: {
      type: "carts",
      attributes: {
        fulfillment_partner: String(partnerId),
        status: "Open",
        user: String(userId),
      },
    },
  });

  const cartId = result?.data?.id;
  if (!cartId) {
    throw new Error("Failed to create cart");
  }

  return String(cartId);
}

/**
 * Reuse an existing open cart for the same partner/location instead of POSTing
 * a new cart. Mariana Tek merges open carts at the same partner into any newly
 * created cart, which can bundle unrelated products into a membership checkout.
 */
export async function getOrCreateCart(userId, partnerId) {
  const existing = await findOpenCartForPartner(userId, partnerId);
  if (existing?.id) {
    return { cartId: String(existing.id), created: false };
  }

  const cartId = await createCart(userId, partnerId);
  return { cartId, created: true };
}

export async function addProductToCart(
  cartId,
  childProductId,
  partnerId,
  productType = "child_products",
  extra = {},
) {
  const quantity = Number(extra.quantity) > 0 ? Number(extra.quantity) : 1;
  const options =
    extra.options == null
      ? []
      : extra.options;
  const hasOptions =
    extra.hasOptions != null
      ? Boolean(extra.hasOptions)
      : Array.isArray(options)
        ? options.length > 0
        : Object.keys(options).length > 0;
  await mtPost(`/carts/${cartId}/add_product`, {
    data: {
      type: "cart_add_product",
      attributes: {
        quantity,
        options,
        has_options: hasOptions,
      },
      relationships: {
        cart: { data: { type: "carts", id: String(cartId) } },
        partner: { data: { type: "partners", id: String(partnerId) } },
        product: {
          data: { type: productType, id: String(childProductId) },
        },
      },
    },
  });
}

/**
 * Empty a line the way custom-offer-flow does: PATCH quantity to 0.
 * MT gates DELETE /cart_lines/{id} (403) and has no remove_product endpoint.
 */
export async function zeroCartLine(lineId) {
  if (!lineId) return;
  await mtPatch(`/cart_lines/${lineId}`, {
    data: {
      type: "cart_lines",
      id: String(lineId),
      attributes: { quantity: 0 },
    },
  });
}

export function snapshotCartLine(line) {
  return {
    lineId: String(line?.id || ""),
    cartId: String(line?.relationships?.cart?.data?.id || ""),
    productId: getLineProductId(line),
    productType: String(
      line?.relationships?.product?.data?.type || "child_products"
    ),
    quantity: lineQuantity(line) > 0 ? lineQuantity(line) : 1,
    partnerId: String(line?.relationships?.partner?.data?.id || ""),
    options: Array.isArray(line?.attributes?.options)
      ? line.attributes.options
      : [],
    hasOptions: Boolean(line?.attributes?.has_options),
  };
}

/**
 * Remove non-membership products from an open cart so checkout is membership-only.
 * Caller must restore via restoreParkedCartItems after checkout (or on failure).
 */
export async function parkForeignCartLines(cartId, allowedProductIds) {
  const allowed = new Set((allowedProductIds || []).map(String));
  const lines = await getCartLines(cartId);
  const foreign = lines.filter(
    (line) => lineQuantity(line) > 0 && !allowed.has(getLineProductId(line))
  );
  const parked = foreign.map(snapshotCartLine);
  for (const line of foreign) {
    await zeroCartLine(line.id);
  }
  if (parked.length) {
    console.log(
      `   🛒 Parked ${parked.length} cart item(s) from cart ${cartId}: ${parked
        .map((p) => p.productId)
        .join(", ")}`
    );
  }
  return parked;
}

export async function restoreParkedCartItems({
  userId,
  partnerId,
  parked = [],
} = {}) {
  if (!parked.length) return null;
  if (!userId || !partnerId) {
    throw new Error("userId and partnerId are required to restore parked cart items");
  }

  const restoredTo = [];
  for (const item of parked) {
    if (item.lineId) {
      try {
        await mtPatch(`/cart_lines/${item.lineId}`, {
          data: {
            type: "cart_lines",
            id: String(item.lineId),
            attributes: { quantity: item.quantity },
          },
        });
        restoredTo.push(`line ${item.lineId}`);
        continue;
      } catch {
        // Cart may already be checked out; add to a new open cart instead.
      }
    }
    const { cartId } = await getOrCreateCart(userId, partnerId);
    await addProductToCart(
      cartId,
      item.productId,
      item.partnerId || partnerId,
      item.productType || "child_products",
      {
        quantity: item.quantity,
        options: item.options,
        hasOptions: item.hasOptions,
      }
    );
    restoredTo.push(`cart ${cartId}`);
  }
  console.log(
    `   🛒 Restored ${parked.length} parked cart item(s) (${restoredTo.join(", ")})`
  );
  return restoredTo[0] || null;
}

export async function getCartTotal(cartId) {
  const result = await mtGet(`/carts/${cartId}`);
  const total = Number(result?.data?.attributes?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

export async function prepareCartForMembership({
  userId,
  partnerId,
  membershipProductId,
  productType = "child_products",
  addProductExtra = {},
}) {
  let parked = [];
  try {
    const existing = await findOpenCartForPartner(userId, partnerId);
    if (existing?.id) {
      parked = await parkForeignCartLines(existing.id, [membershipProductId]);
    }

    const { cartId, created } = await getOrCreateCart(userId, partnerId);

    const alreadyInCart = await cartContainsProduct(cartId, membershipProductId);
    if (!alreadyInCart) {
      await addProductToCart(
        cartId,
        membershipProductId,
        partnerId,
        productType,
        addProductExtra
      );
    }

    return { cartId, created, membershipAdded: !alreadyInCart, parked };
  } catch (error) {
    if (parked.length) {
      try {
        await restoreParkedCartItems({ userId, partnerId, parked });
      } catch (restoreError) {
        console.warn(
          `   ⚠️  Failed to restore parked cart items: ${restoreError.message}`
        );
      }
    }
    throw error;
  }
}
