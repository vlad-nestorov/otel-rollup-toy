#!/usr/bin/env bash
# Usage: annotate.sh <title> <command...>
# Runs the command and also posts the tail of its output as a workflow annotation.
# Annotations are readable through the GitHub checks API, which is handy when the
# raw job logs aren't reachable.
title="$1"
shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
level=notice
if [ "$status" -ne 0 ]; then level=error; fi
body="$(tail -n 80 "$log" | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/%/%25/g' -e 's/\r/%0D/g' | sed -e ':a' -e 'N' -e '$!ba' -e 's/\n/%0A/g')"
echo "::${level} title=${title} (exit ${status})::${body}"
exit "$status"
