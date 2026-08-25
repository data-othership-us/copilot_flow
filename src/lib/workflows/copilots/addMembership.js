/**
 * Add memberships to a discount payload based on tier
 * @param {string} tier - "coPilot", "wayFinder", "luminary"
 * @param {Array} discountIncludedMemberships - Array to push membership objects to
 */
export function addMembershipsToDiscount(tier, discountIncludedMemberships) {
  
  const MEMBERSHIPS = {
    coPilot: [
      { id: "17075", title: "Seeker NY Co-Pilot Membership" },
      { id: "17073", title: "Seeker TO Co-Pilot Membership" }
    ],
    wayFinder: [
      { id: "17071", title: "Wayfinder NY Co-Pilot Membership" },
      { id: "17069", title: "Wayfinder TO Co-Pilot Membership" }
    ],
    luminary: [
      { id: "17067", title: "Luminary NY Co-Pilot Membership" },
      { id: "17065", title: "Luminary TO Co-Pilot Membership" }
    ]
  };

  const memberships = MEMBERSHIPS[tier];

  if (!memberships) {
    console.warn(`No memberships found for tier "${tier}"`);
    return;
  }

  memberships.forEach(m => discountIncludedMemberships.push(m));

  console.log(`Added ${memberships.length} memberships for tier: ${tier}`);
}
