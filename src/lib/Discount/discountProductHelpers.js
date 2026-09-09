import productsData from "./discountProducts.json" assert { type: "json" };
import { composeDisplayName } from "../notion/parseProps.js";

function formatProductClass(productClass) {
  const name =
    productClass.name === "Membership" ? "Memberships" : productClass.name;
  const slug =
    productClass.slug === "membership" ? "memberships" : productClass.slug;
  return { id: productClass.id, name, slug };
}

export function getTorontoProductsForAPI() {
  return productsData.toronto.map((product) => ({
    id: product.id,
    title: product.title,
    product_class: formatProductClass(product.product_class),
  }));
}

export function getNYCProductsForAPI() {
  return productsData.nyc.map((product) => ({
    id: product.id,
    title: product.title,
    product_class: formatProductClass(product.product_class),
  }));
}

export function formatDiscountName(tier, firstName, lastName) {
  const tierLabel =
    tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
  const person = composeDisplayName(firstName, lastName);
  return `${tierLabel} ${person}`.trim();
}
