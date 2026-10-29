import { describe, it, expect } from "vitest";
import { AppCatalog, lookupApp, listApps, APP_CATALOG_SOURCE } from "./apps.js";
import { parseQuery } from "../core/parser.js";
import { find } from "../core/find.js";

// #30: the app catalog was a hand copy that dropped every alias, so the names
// people actually use (ImageJ, pv, chimera) stopped resolving. It is now
// generated from libs catalog/catalog.yaml; these cases are ported from libs
// catalog_test.go and truffle pkg/find/parser_test.go TestParseQuery_AppToken.

describe("lookupApp (libs catalog_test.go)", () => {
  it("finds by name", () => {
    const e = lookupApp("paraview")!;
    expect(e.name).toBe("paraview");
    expect(e.gpu).toBe(true);
    expect(e.instanceFamilies.length).toBeGreaterThan(0);
  });
  it("finds by alias", () => {
    expect(lookupApp("pv")?.name).toBe("paraview");
    expect(lookupApp("imagej")?.name).toBe("fiji");
    expect(lookupApp("chimera")?.name).toBe("chimerax");
  });
  it("is case-insensitive", () => {
    for (const n of ["ParaView", "PARAVIEW", "paraview", " ImageJ "]) expect(lookupApp(n), n).toBeDefined();
  });
  it("misses an unknown name", () => {
    expect(lookupApp("notarealapplication")).toBeUndefined();
  });
  it("lists every app, sorted by name", () => {
    const names = listApps().map((a) => a.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...names].sort());
  });
});

describe("parseQuery app tokens (truffle parser_test.go TestParseQuery_AppToken)", () => {
  const cases: [string, string, string[]][] = [
    ["app by canonical name", "paraview", ["paraview"]],
    ["app by alias", "pv", ["paraview"]],
    ["app by alias imagej", "imagej", ["fiji"]],
    ["app case insensitive", "ParaView", ["paraview"]],
    ["non-app word is not app", "nvidia", []],
    ["unknown word is not app", "notarealapplication graviton", []],
  ];
  for (const [name, query, want] of cases) {
    it(name, () => expect(parseQuery(query).apps).toEqual(want));
  }
});

describe("the catalog matches upstream, not a paraphrase (#30)", () => {
  it("records the libs version it was generated from", () => {
    expect(APP_CATALOG_SOURCE).toMatch(/^spore-host\/libs v\d+\.\d+\.\d+/);
  });
  it("carries upstream's descriptions verbatim", () => {
    expect(AppCatalog.chimerax.description).toBe("Protein structure visualization, cryo-EM (UCSF ChimeraX)");
    expect(AppCatalog.igv.description).toBe("Integrative Genomics Viewer — genome browser, sequencing data");
  });
  it("keeps chimerax's high-VRAM family and every app's min VRAM / license", () => {
    expect(AppCatalog.chimerax.highVramFamilies).toEqual(["g6e"]);
    expect(AppCatalog.paraview.minVramGiB).toBe(24);
    expect(AppCatalog.chimerax.minVramGiB).toBe(24);
    for (const a of listApps()) expect(a.license, a.name).toBe("open-source");
  });
  it("includes the web and desktop apps upstream added", () => {
    expect(lookupApp("vscode")?.name).toBe("code-server");
    expect(lookupApp("jupyterlab")?.kind).toBe("web");
    expect(lookupApp("desktop")?.kind).toBe("desktop");
    expect(AppCatalog.paraview.kind).toBe("application");
  });
});

describe("find() through an alias (#30 failure scenario)", () => {
  it("find('imagej') resolves fiji: c7i/m7i, at least 4 vCPU / 16 GiB", async () => {
    const results = await find("imagej");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(["c7i", "m7i"]).toContain(r.instance.instanceFamily);
      expect(r.instance.vcpus).toBeGreaterThanOrEqual(4);
      expect(r.instance.memoryMib / 1024).toBeGreaterThanOrEqual(16);
    }
  });
  it("find('pv') and find('chimera') resolve their GPU apps", async () => {
    for (const [q, fams] of [
      ["pv", ["g6", "g5", "g4dn"]],
      ["chimera", ["g6", "g5"]],
    ] as const) {
      const results = await find(q);
      expect(results.length, q).toBeGreaterThan(0);
      for (const r of results) expect(fams as readonly string[]).toContain(r.instance.instanceFamily);
    }
  });
});
