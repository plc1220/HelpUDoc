from __future__ import annotations

from _data_common import json_dump, read_request, write_out_json


def main() -> None:
    request = read_request()
    payload = {
        "ok": True,
        "widget_type": "artifact",
        "manifest": request.get("manifest") or {},
        "snapshot": request.get("snapshot") or {},
        "sources": request.get("sources") or [],
    }
    write_out_json("result.json", payload)
    print(json_dump({"ok": True, "artifactTitle": payload["manifest"].get("title") if isinstance(payload["manifest"], dict) else None}))


if __name__ == "__main__":
    main()
