import type { AgreementCounts } from "../agreement.ts";

/**
 * Agreement of the java lexer profile with the structural layer over the corpus of every adapter that uses it
 * (fixtures/languages/<id>/adapter, metrics and agreement). Written by the agreement test: run it with
 * UPDATE_AGREEMENT=1 after a deliberate change. Checked by it in CI, so a profile change cannot make the rates worse unnoticed.
 */
export const recorded: AgreementCounts = { units: 58, found: 55, exact: 55, blocks: 63, spurious: 0 };
