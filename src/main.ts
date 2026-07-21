// Demo entry. A thin consumer of the truffle-ts library — the standalone search
// UI is built out in issue #6. For now it renders a placeholder so the Vite demo
// build has an entry point and the Pages deploy has something to serve.

import { VERSION } from "./index.js";

const app = document.getElementById("app");
if (app) {
  app.innerHTML = `
    <main class="scaffold">
      <h1>truffle <span class="v">v${VERSION}</span></h1>
      <p>Browser-native EC2 instance discovery. The search UI is coming soon.</p>
    </main>`;
}
