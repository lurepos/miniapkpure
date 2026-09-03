import { queryPackages } from "../src/index.js";

async function run() {
  const searchTerm = "browser";
  const results = await queryPackages(searchTerm);

  if (results.length === 0) {
    return;
  }

  console.log(results.slice(0, 5));
}

run().catch(() => {});
