import { fileURLToPath } from "node:url";
import path from "node:path";
const here = path.dirname(fileURLToPath(import.meta.url));
const viewer = path.join(here, "..", "viewer", "index.html");
console.log("here:", here);
console.log("viewer:", viewer);
