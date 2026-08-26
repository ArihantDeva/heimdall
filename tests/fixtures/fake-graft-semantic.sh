#!/usr/bin/env bash
# fake-graft-semantic.sh — graft stub emitting two hits: one whose body matches
# any query (semantic marker handled by embed-index stub), one matching nothing.
printf '%s\n' '{"hits":[{"pointer":"src/matches.py:1","title":"zzmatchtoken","score":2,"snippet":"zzmatchtoken"},{"pointer":"src/no-match.py:1","title":"unrelated words","score":1,"snippet":"nothing here"}]}'
