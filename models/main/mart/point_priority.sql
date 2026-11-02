{{ config(materialized='table') }}

-- 点の種類と出どころごとの優先順。同じ住所に点が複数あるとき、rank の小さいものを既定の点にする。
-- error_m は地価公示の地点 (住所と測った座標の組) に当てたときの距離の中央値。新しい出どころを
-- 足すときは、同じ地点で測ってから rank を決める
SELECT * FROM (VALUES
    ('parcel',        'abr', 1, 3,    DATE '2026-11-01'),
    ('rsdt',          'abr', 2, 47,   DATE '2026-11-01'),
    ('parcel_parent', 'abr', 3, NULL, NULL),
    ('parcel_parent', 'isj', 4, 37,   DATE '2026-11-01'),
    ('block',         'abr', 5, 76,   DATE '2026-11-01'),
    ('block',         'isj', 6, NULL, NULL)
) AS t(point_type, source, rank, error_m, measured_on)
ORDER BY rank
