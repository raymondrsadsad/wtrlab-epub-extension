// Adapter registry: pick a site adapter by URL, else fall back to generic.
// To add a new site: create adapters/<site>.js exporting create(), import it here,
// and add its factory to SITE_ADAPTERS (before the generic fallback).
import { create as createWtrlab } from "./wtrlab.js";
import { create as createKakuyomu } from "./kakuyomu.js";
import { create as createNewtoki } from "./newtoki.js";
import { create as createGeneric } from "./generic.js";

const SITE_ADAPTERS = [createWtrlab, createKakuyomu, createNewtoki];
const BY_ID = { wtrlab: createWtrlab, kakuyomu: createKakuyomu, newtoki: createNewtoki, generic: createGeneric };

export function pickAdapter(url) {
  for (const factory of SITE_ADAPTERS) {
    const a = factory();
    try { if (a.matches(url)) return a; } catch {}
  }
  return createGeneric();
}

// Force a specific adapter by id ("wtrlab" | "generic"); falls back to auto.
export function adapterById(id, url) {
  const factory = BY_ID[id];
  return factory ? factory() : pickAdapter(url);
}
