import { refresh } from "../../src/refresh.ts";

const result = await refresh(process.argv[2]!);
process.stdout.write(String(result.added));
