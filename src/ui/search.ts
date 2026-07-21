// The standalone demo — a search box over the truffle-ts library. It's a thin
// consumer of the public API (find + CATALOG_AS_OF): type a natural-language
// query, pick a sort, see the matching instance types with the reasons they
// matched and an estimated $/hr. DOM lives only here; the library is pure.

import { find, CATALOG_AS_OF, type FindResult, type SortPreference } from "../index.js";

const EXAMPLES = [
  "nvidia h100 8gpu efa",
  "cheapest graviton 8 cores 32gb",
  "amd genoa 64gb",
  "paraview",
  "fastest arm64",
];

export class SearchApp {
  readonly el: HTMLElement;
  private input!: HTMLInputElement;
  private sortSel!: HTMLSelectElement;
  private resultsEl!: HTMLElement;
  private msgEl!: HTMLElement;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "search-app";
    this.el.innerHTML = `
      <header>
        <h1>truffle <span class="tag">browser</span></h1>
        <p class="sub">EC2 instance discovery — ask in plain language.
          <span class="badge" title="Offline bundled catalog, not live AWS data">bundled catalog · as of ${CATALOG_AS_OF}</span>
        </p>
      </header>
      <form class="q">
        <input class="q-input" spellcheck="false" autocomplete="off"
          aria-label="instance query" placeholder="nvidia h100 8gpu efa" />
        <label>sort
          <select class="q-sort">
            <option value="">(auto)</option>
            <option value="cheapest">cheapest</option>
            <option value="expensive">most expensive</option>
            <option value="performant">most vCPUs</option>
            <option value="newest">newest gen</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <div class="examples"></div>
      <div class="q-msg"></div>
      <div class="results"></div>`;

    this.input = this.el.querySelector(".q-input")!;
    this.sortSel = this.el.querySelector(".q-sort")!;
    this.resultsEl = this.el.querySelector(".results")!;
    this.msgEl = this.el.querySelector(".q-msg")!;

    this.el.querySelector<HTMLFormElement>(".q")!.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.run();
    });

    const ex = this.el.querySelector(".examples")!;
    ex.append(document.createTextNode("try: "));
    for (const q of EXAMPLES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "example";
      b.textContent = q;
      b.addEventListener("click", () => {
        this.input.value = q;
        void this.run();
      });
      ex.appendChild(b);
    }
  }

  private async run(): Promise<void> {
    const query = this.input.value.trim();
    if (!query) return;
    let results: FindResult[];
    try {
      const sort = (this.sortSel.value || undefined) as SortPreference | undefined;
      results = await find(query, sort ? { sort } : {});
    } catch (err) {
      this.msgEl.textContent = (err as Error).message;
      this.msgEl.className = "q-msg bad";
      this.resultsEl.innerHTML = "";
      return;
    }
    this.msgEl.textContent = `${results.length} match${results.length === 1 ? "" : "es"}`;
    this.msgEl.className = "q-msg";
    this.renderResults(results);
  }

  private renderResults(results: FindResult[]): void {
    if (results.length === 0) {
      this.resultsEl.innerHTML = `<div class="empty">no instance types match — try broadening the query</div>`;
      return;
    }
    const rows = results
      .map((r) => {
        const i = r.instance;
        const mem = (i.memoryMib / 1024).toLocaleString();
        const gpu = i.gpus ? `${i.gpus}× ${escapeHtml(i.gpuModel ?? "GPU")}` : "—";
        const price = i.onDemandPrice ? `$${i.onDemandPrice.toFixed(4)}` : "—";
        return `<tr>
          <td class="mono">${escapeHtml(i.instanceType)}</td>
          <td>${i.vcpus}</td>
          <td>${mem} GiB</td>
          <td>${gpu}</td>
          <td>${i.architecture}</td>
          <td class="price">${price}<span class="hr">/hr</span></td>
          <td class="reasons">${r.reasons.map((x) => `<span>${escapeHtml(x)}</span>`).join("")}</td>
        </tr>`;
      })
      .join("");
    this.resultsEl.innerHTML = `
      <table>
        <thead><tr><th>type</th><th>vCPU</th><th>memory</th><th>GPU</th><th>arch</th><th>~$/hr</th><th>why</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  focus(): void {
    this.input.focus();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
