// Demo entry. Mounts the standalone search UI — a consumer of the truffle-ts
// library (src/index.ts). The library itself has no DOM dependency; this page is
// just one way to drive it.

import { SearchApp } from "./ui/search.js";

const app = document.getElementById("app");
if (app) {
  const search = new SearchApp();
  app.appendChild(search.el);
  search.focus();
}
