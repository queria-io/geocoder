"""BigQuery のリモート関数から Queria Geocoder を呼ぶ中継 (Cloud Run functions)。

BigQuery は行をまとめて {"calls": [[住所], ...]} で送ってくる。/v1/batch に 25 件ずつ渡し、
同じ順で {"replies": [結果の JSON または null, ...]} を返す。
"""

import os
import time

import functions_framework
import requests

API = os.environ.get("GEOCODER_URL", "https://geocoder.queria.io") + "/v1/batch"
INCLUDE = os.environ.get("GEOCODER_INCLUDE", "ids,codes,small_area")
BATCH = 25


def post(addresses: list[str]) -> list[dict | None]:
    for wait in [0, 5, 15, 30, 60]:
        time.sleep(wait)
        r = requests.post(API, json={"addresses": addresses, "include": INCLUDE}, timeout=60)
        if r.status_code != 429:
            r.raise_for_status()
            return r.json()["results"]
    r.raise_for_status()
    return []


@functions_framework.http
def geocode(request):
    addresses = [(call[0] or "").strip() for call in request.get_json()["calls"]]
    try:
        replies = [
            result
            for i in range(0, len(addresses), BATCH)
            for result in post([a or "-" for a in addresses[i : i + BATCH]])
        ]
    except requests.RequestException as e:
        # 503 なら BigQuery が時間をおいて送り直す
        return {"errorMessage": str(e)}, 503
    return {"replies": [r if a else None for a, r in zip(addresses, replies)]}
