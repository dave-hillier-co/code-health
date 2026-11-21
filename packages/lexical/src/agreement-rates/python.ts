import type { AgreementCounts } from "../agreement.ts";

/**
 * Agreement of the python lexer profile with the structural layer over the corpus of every adapter that uses it
 * (fixtures/languages/<id>/adapter, metrics and agreement). Written by the agreement test: run it with
 * UPDATE_AGREEMENT=1 after a deliberate change. Checked by it in CI, so a profile change cannot make the rates worse unnoticed.
 */
export const recorded: AgreementCounts = { units: 66, found: 64, exact: 63, blocks: 63, spurious: 0 };
