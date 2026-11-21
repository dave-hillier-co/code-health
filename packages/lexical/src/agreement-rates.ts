import type { AgreementCounts } from "./agreement.ts";

/**
 * Agreement of each lexer profile with the structural layer over the corpus in fixtures/lexical-agreement
 * and fixtures/ts-adapter. Written by the agreement test (run it with UPDATE_AGREEMENT=1 after a deliberate
 * change) and checked by it in CI, so a profile change cannot make the rates worse unnoticed.
 * Only profiles with a structural adapter appear here.
 */
export const recordedAgreement: Record<string, AgreementCounts> = {
  typescript: { units: 75, found: 74, exact: 74, blocks: 83, spurious: 6 },
};
