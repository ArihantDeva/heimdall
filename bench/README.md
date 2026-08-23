# bench/ — LongMemEval measurement harness

Isolated benchmark subtree for Heimdall × LongMemEval (Plan 1: measurement
loop & baseline reproduction). Nothing here is imported by Heimdall runtime
code in `bin/` or `extensions/`.

## Layout

- `fetch_data.sh` — downloads the LongMemEval dataset from HuggingFace
  (`xiaowu0162/longmemeval`) into `data/` (gitignored). Writes SHA-256
  checksums to `data.sha256`.
- `tests/` — dataset integrity tests (run before any benchmarking).

## Dataset contract

`load_dataset(name) -> list[dict]`, where each question dict has keys:

- `question_id`
- `question_type`
- `question`
- `answer`
- `question_date`
- `haystack_sessions`
- `haystack_dates`
- `answer_session_ids`

## Usage

```bash
DATA=bench/data bash bench/fetch_data.sh
~/.heimdall/venv/bin/python3 -m pytest bench/tests/test_data_integrity.py -v
```

## Constraints honored here

- Benchmark ingest goes ONLY to a dedicated `longmemeval` graft profile —
  never to the live `default` profile.
- No LLM calls at ingest time (embeddings/rerankers are CPU-only and allowed).
- `longmemeval_m` is deliberately not fetched by default (disk budget);
  downloading it must be a conscious separate decision.
