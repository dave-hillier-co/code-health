#!/bin/sh
# The same repository as abandonment-scaffold.sh, where nobody has opted in to the abandonment analysis.
set -e
sh "$(dirname "$0")/abandonment-scaffold.sh"
rm -f code-health.json
