#!/bin/sh
# Builds a repository with a pass-through layer: a service whose methods only forward to a store, committed on a fixed date.
set -eu
git init -q --initial-branch=main
git config user.name "Eval Author"
git config user.email "eval@example.com"
git config commit.gpgsign false
mkdir -p src

cat > src/store.js <<'EOF'
export function save(record, options) {
  const rows = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined && options.fields.includes(key)) {
      rows.push({ key, value: String(value).trim() });
    }
  }
  return rows;
}

export function load(id, options) {
  return options.fields.map((field) => ({ id, field }));
}
EOF

cat > src/service.js <<'EOF'
import { load, save } from "./store.js";

export function saveRecord(record, options) {
  return save(record, options);
}

export function loadRecord(id, options) {
  return load(id, options);
}
EOF

git add --all
GIT_AUTHOR_DATE=2024-01-01T09:00:00Z GIT_COMMITTER_DATE=2024-01-01T09:00:00Z git commit -q -m "Add the store and its service"
