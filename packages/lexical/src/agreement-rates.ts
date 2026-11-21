import type { AgreementCounts } from "./agreement.ts";
import * as recorded from "./recorded-agreement.ts";

/**
 * Agreement of each lexer profile with the structural layer, recorded per profile in agreement-rates/<profile>.ts
 * and registered by one line in recorded-agreement.ts. Only profiles with a structural adapter appear here.
 * The agreement test records them and checks them in CI (see packages/parse/test/lexical-agreement.test.ts).
 */
export const recordedAgreement: Record<string, AgreementCounts> = { ...recorded };
