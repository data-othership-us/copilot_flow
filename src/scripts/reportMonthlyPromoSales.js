/**
 * Monthly Co-Pilot promo-code sales report.
 *
 *   npm run report-monthly-sales
 *   MONTH=2026-09 npm run report-monthly-sales
 *   MONTH=2026-09 REGION=TO npm run report-monthly-sales
 */
import "../config.js";
import { reportMonthlyPromoSales } from "../jobs/reportMonthlyPromoSales.js";

reportMonthlyPromoSales()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
