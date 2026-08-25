import { mtGet, mtPost } from "./marianatekClient.js";

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
  return response?.data ?? [];
}

export function getLineProductId(line) {
  return String(line?.relationships?.product?.data?.id ?? "");
}

export async function cartContainsProduct(cartId, productId) {
  const target = String(productId);
  const lines = await getCartLines(cartId);
  return lines.some((line) => getLineProductId(line) === target);
}

export async function assertCartHasOnlyAllowedProducts(cartId, allowedProductIds) {
  const allowed = new Set(allowedProductIds.map(String));
  const lines = await getCartLines(cartId);
  const foreign = lines.filter((line) => !allowed.has(getLineProductId(line)));

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
) {
  await mtPost(`/carts/${cartId}/add_product`, {
    data: {
      type: "cart_add_product",
      attributes: {
        quantity: 1,
        options: [],
        has_options: false,
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
}) {
  const { cartId, created } = await getOrCreateCart(userId, partnerId);

  if (!created) {
    await assertCartHasOnlyAllowedProducts(cartId, [membershipProductId]);
  }

  const alreadyInCart = await cartContainsProduct(cartId, membershipProductId);
  if (!alreadyInCart) {
    await addProductToCart(cartId, membershipProductId, partnerId, productType);
  }

  return { cartId, created, membershipAdded: !alreadyInCart };
}
