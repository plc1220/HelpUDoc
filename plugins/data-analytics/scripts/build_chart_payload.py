from __future__ import annotations

from _data_common import json_dump, read_request, write_out_json


def main() -> None:
    request = read_request()
    payload = {
        "ok": True,
        "widget_type": "chart",
        "source": request.get("source") or {},
        "table": request.get("table") or {},
        "chart": request.get("chart") or {},
        "display": request.get("display") or {},
    }
    write_out_json("result.json", payload)
    print(json_dump(payload))


if __name__ == "__main__":
    main()
