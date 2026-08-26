#!/usr/bin/env python3
"""Read canonical manual-memory JSON as embed-index card tuples."""
from __future__ import annotations

import json
import pathlib
import re
from typing import List, Optional, Tuple

SCHEMA = "heimdall.memory.v1"


def _valid(record: object, path: pathlib.Path) -> bool:
    return (
        isinstance(record, dict)
        and record.get("schema") == SCHEMA
        and isinstance(record.get("id"), str)
        and bool(re.fullmatch(
            r"mem-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
            record["id"],
            re.IGNORECASE,
        ))
        and path.name == record["id"] + ".json"
        and isinstance(record.get("title"), str)
        and bool(record["title"].strip())
        and isinstance(record.get("body"), str)
        and bool(record["body"].strip())
        and isinstance(record.get("keywords"), list)
        and all(isinstance(k, str) and bool(k) and k.strip() == k for k in record["keywords"])
        and isinstance(record.get("createdAt"), str)
        and bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", record["createdAt"]))
        and isinstance(record.get("cwd"), str)
        and pathlib.Path(record["cwd"]).is_absolute()
    )


def memory_cards(
    home: Optional[pathlib.Path] = None,
) -> List[Tuple[str, str, str, str, str]]:
    root = (home or pathlib.Path.home()) / ".heimdall" / "memories"
    cards = []
    if not root.is_dir():
        return cards
    for path in sorted(root.glob("*.json")):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            continue
        if not _valid(record, path):
            continue
        context = "\n".join([
            record["body"],
            "keywords: " + " ".join(record["keywords"]),
            "cwd: " + record["cwd"],
        ])
        cards.append(
            (f"memory:{record['id']}", root.as_posix(), path.name, record["title"], context)
        )
    return cards


if __name__ == "__main__":
    print(json.dumps(memory_cards()))
