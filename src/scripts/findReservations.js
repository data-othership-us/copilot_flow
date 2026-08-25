import { findReservations } from "../lib/workflows/copilots/findReservations.js";

findReservations()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
