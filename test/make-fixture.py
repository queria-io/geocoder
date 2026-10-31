# test/fixture.pmtiles を作る。東京駅 (139.7671, 35.6812) の入るタイルにだけ形を置く。
#   z13 small_area: タイルの左半分 (code 131010010)。その中に正方形の穴
#   z12 city: タイル全体 (code 13101)
#   z10 prefecture: タイル全体 (code 13)
# 使い方: uv run --with mapbox-vector-tile --with pmtiles python test/make-fixture.py
import gzip, math
import mapbox_vector_tile
from pmtiles.tile import zxy_to_tileid, TileType, Compression
from pmtiles.writer import Writer

LNG, LAT = 139.7671, 35.6812


def tile_of(z):
    n = 2**z
    x = int((LNG + 180) / 360 * n)
    y = int((1 - math.asinh(math.tan(math.radians(LAT))) / math.pi) / 2 * n)
    return x, y


# mapbox_vector_tile は y を上向きに受け取るので、y_coord_down=True で MVT と同じ向きにそろえる
def encode(layer, wkt, code):
    data = mapbox_vector_tile.encode(
        [{"name": layer, "features": [{"geometry": wkt, "properties": {"code": code}}]}],
        default_options={"y_coord_down": True, "extents": 4096},
    )
    return gzip.compress(data)


half = "POLYGON ((0 0, 2048 0, 2048 4096, 0 4096, 0 0), (500 500, 1000 500, 1000 1000, 500 1000, 500 500))"
whole = "POLYGON ((0 0, 4096 0, 4096 4096, 0 4096, 0 0))"
tiles = [
    (10, "prefecture", whole, "13"),
    (12, "city", whole, "13101"),
    (13, "small_area", half, "131010010"),
]
entries = sorted((zxy_to_tileid(z, *tile_of(z)), encode(l, g, c)) for z, l, g, c in tiles)

with open("test/fixture.pmtiles", "wb") as f:
    w = Writer(f)
    for tile_id, data in entries:
        w.write_tile(tile_id, data)
    w.finalize(
        {
            "tile_type": TileType.MVT,
            "tile_compression": Compression.GZIP,
            "min_zoom": 10,
            "max_zoom": 13,
            "min_lon_e7": int(139 * 1e7),
            "min_lat_e7": int(35 * 1e7),
            "max_lon_e7": int(140 * 1e7),
            "max_lat_e7": int(36 * 1e7),
            "center_zoom": 13,
            "center_lon_e7": int(LNG * 1e7),
            "center_lat_e7": int(LAT * 1e7),
        },
        {"vector_layers": []},
    )
for z in (10, 12, 13):
    print(z, tile_of(z))
