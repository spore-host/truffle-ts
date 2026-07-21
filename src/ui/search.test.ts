// @vitest-environment happy-dom
//
// DOM test for the demo search widget. Drives the real DOM the SearchApp builds
// — submitting a query, clicking an example, toggling sort — and asserts the
// rendered results table. Runs the actual library (bundled catalog) underneath.

import { describe, it, expect, beforeEach } from "vitest";
import { SearchApp } from "./search.js";

function mount(): SearchApp {
  document.body.innerHTML = "";
  const app = new SearchApp();
  document.body.appendChild(app.el);
  return app;
}

function setQuery(app: SearchApp, q: string) {
  (app.el.querySelector(".q-input") as HTMLInputElement).value = q;
}

async function submit(app: SearchApp) {
  app.el.querySelector<HTMLFormElement>(".q")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  await new Promise((r) => setTimeout(r, 0));
}

describe("SearchApp", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a staleness badge and example chips", () => {
    const app = mount();
    expect(app.el.querySelector(".badge")!.textContent).toContain("as of");
    expect(app.el.querySelectorAll(".example").length).toBeGreaterThan(0);
  });

  it("runs a query and renders matching rows with reasons", async () => {
    const app = mount();
    setQuery(app, "nvidia h100 8gpu efa");
    await submit(app);
    const table = app.el.querySelector("table")!;
    expect(table).toBeTruthy();
    expect(table.textContent).toContain("p5.48xlarge");
    // A "why" reason chip is rendered.
    expect(app.el.querySelector("td.reasons span")).toBeTruthy();
    expect(app.el.querySelector(".q-msg")!.textContent).toMatch(/match/);
  });

  it("honors the sort selector (cheapest first)", async () => {
    const app = mount();
    setQuery(app, "graviton 8 cores 32gb");
    (app.el.querySelector(".q-sort") as HTMLSelectElement).value = "cheapest";
    await submit(app);
    const prices = [...app.el.querySelectorAll("td.price")].map((td) =>
      parseFloat(td.textContent!.replace(/[^0-9.]/g, "")),
    );
    const sorted = [...prices].sort((a, b) => a - b);
    expect(prices).toEqual(sorted);
  });

  it("clicking an example chip fills and runs it", async () => {
    const app = mount();
    (app.el.querySelector(".example") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect((app.el.querySelector(".q-input") as HTMLInputElement).value).not.toBe("");
    expect(app.el.querySelector("table")).toBeTruthy();
  });

  it("shows an error for an empty-after-conflict query without throwing", async () => {
    const app = mount();
    setQuery(app, "intel graviton"); // conflicting architectures → parse throws
    await submit(app);
    expect(app.el.querySelector(".q-msg.bad")!.textContent).toMatch(/conflicting/);
    expect(app.el.querySelector("table")).toBeNull();
  });

  it("renders an empty-state for a valid but unmatchable query", async () => {
    const app = mount();
    setQuery(app, "igv nvidia"); // disjoint → never-match
    await submit(app);
    expect(app.el.querySelector(".empty")).toBeTruthy();
  });
});
