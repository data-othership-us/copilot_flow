import path from "path";
import { fileURLToPath } from "url";
import { createDiscountsFromList } from "../lib/workflows/copilots/createDiscountsFromList.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultListPath = path.resolve(
  __dirname,
  "../../../../seeker_discounts.csv"
);

const listPath = process.argv[2] || defaultListPath;

createDiscountsFromList(listPath)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
