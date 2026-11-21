import { core } from "@acme/core";
import { strings } from "@acme/core/util/strings";
import { c } from "@acme/core/conditional";
import { hidden } from "@acme/core/hidden";
import { entry } from "legacy-lib";
import { helper } from "legacy-lib/lib/helpers";
import { other } from "unknown-package";

export const app = [core, strings, c, hidden, entry, helper, other];
