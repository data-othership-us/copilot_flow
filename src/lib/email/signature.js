import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultSignaturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../emails/defaultSignature.html"
);

/**
 * HTML for the sign-off block. Gmail’s web signature is not appended over the API.
 */
export function getEmailSignatureHtml() {
  return fs.readFileSync(defaultSignaturePath, "utf8").trim();
}
