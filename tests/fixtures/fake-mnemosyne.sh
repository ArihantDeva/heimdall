#!/usr/bin/env bash
# fake-mnemosyne.sh — stub for kb-search backend tests. Emits the same shape
# as `mnemosyne recall <q> <top_k> --json` (mnemosyne-oss v3.15.x).
printf '%s\n' '{"query":"example","top_k":6,"results":[{"id":"mem-1","content":"Mnemo hit content","score":0.91}]}'
