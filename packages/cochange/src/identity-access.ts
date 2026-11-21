import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createNonPersonMatcher, type NonPersonMatcher } from "@code-health/history/identity-classify";
import {
  identityFiles,
  readDecisions,
  resolveLocation,
  type IdentityDecisions,
  type MappingLocation,
} from "@code-health/history/identity-decisions";
import type { CochangeSettings } from "./config.ts";

export interface IdentityState {
  /** The chosen location, or null when nothing says and the identities skill has not asked yet. */
  location: MappingLocation | null;
  decisions: IdentityDecisions;
  matcher: NonPersonMatcher;
  /** The local-only mailmap, when there is one. It is passed to git beside the tracked `.mailmap`. */
  localMailmap: string | undefined;
  /**
   * What results depend on beyond the repository's tracked state, stamped for the
   * output's `inputs`: a short hash of each file that is present.
   */
  stamps: { decisions?: string; localMailmap?: string };
}

const stamp = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

/** Reads the identity decisions and builds the classification every history read uses. */
export function loadIdentityState(root: string, settings: CochangeSettings): IdentityState {
  const files = identityFiles(root);
  const location = resolveLocation(root, settings.identities.location);
  const decisions = readDecisions(root);
  const stamps: IdentityState["stamps"] = {};
  const decisionFiles = [files.committedDecisions, files.localDecisions].filter((f) => existsSync(f));
  if (decisionFiles.length > 0) {
    stamps.decisions = createHash("sha256").update(decisionFiles.map(stamp).join(",")).digest("hex").slice(0, 16);
  }
  const localMailmap = existsSync(files.localMailmap) ? files.localMailmap : undefined;
  if (localMailmap) stamps.localMailmap = stamp(localMailmap);
  return {
    location,
    decisions,
    localMailmap,
    stamps,
    matcher: createNonPersonMatcher({
      botPatterns: settings.identities.botPatterns,
      servicePatterns: settings.identities.servicePatterns,
      agentPatterns: settings.identities.agentTrailerPatterns,
      decisions: decisions.classifications,
    }),
  };
}
