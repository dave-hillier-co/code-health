#!/bin/sh
# Builds the repository the scrutiny eval runs in: a formatter that eight features use, always with the same flag.
set -e
git init -q -b main
git config user.email eval@example.com
git config user.name Eval
mkdir -p src/shared src/features
cat > code-health.json <<'JSON'
{ "entryPoints": ["src/main.ts"] }
JSON
cat > src/shared/format.ts <<'TS'
export function fmt(value: number, compact: boolean): string {
  return compact ? String(value) : value.toFixed(2);
}
TS
: > src/main.ts
for n in 1 2 3 4 5 6 7 8; do
  cat > "src/features/feature$n.ts" <<TS
import { fmt } from "../shared/format.ts";
export function feature$n(): string {
  return fmt($n, true);
}
TS
  echo "import { feature$n } from \"./features/feature$n.ts\";" >> src/main.ts
done
echo "export const run = () => [feature1(), feature2(), feature3(), feature4(), feature5(), feature6(), feature7(), feature8()];" >> src/main.ts
git add -A
GIT_AUTHOR_DATE=2024-01-01T09:00:00Z GIT_COMMITTER_DATE=2024-01-01T09:00:00Z git commit -q -m "Add the app"
# The code is a year old by the last commit.
echo "Notes." > NOTES.md
git add -A
GIT_AUTHOR_DATE=2025-01-01T09:00:00Z GIT_COMMITTER_DATE=2025-01-01T09:00:00Z git commit -q -m "Add notes"
