import type { AgreementCounts } from "../agreement.ts";

/**
 * Agreement of the rust lexer profile with the structural layer over the corpus of every adapter that uses it
 * (fixtures/languages/<id>/adapter, metrics and agreement). Written by the agreement test: run it with
 * UPDATE_AGREEMENT=1 after a deliberate change. Checked by it in CI, so a profile change cannot make the rates worse unnoticed.
 */
export const recorded: AgreementCounts = { units: 61, found: 59, exact: 56, blocks: 56, spurious: 0 };
