{{ config(materialized='table') }}

-- 点の種類と出どころごとの優先順。同じ住所に点が複数あるとき、rank の小さいものを既定の点にする。
-- error_m は地価公示の地点 (住所と測った座標の組) に当てたときの距離の中央値。新しい出どころを
-- 足すときは、同じ地点で測ってから rank を決める
SELECT * FROM (VALUES
    ('parcel',        'abr', 1, 3,    DATE '2026-11-01'),
    -- 登記所備付地図の筆の代表点。ABR の地番の点と同じ作り方 (ABR に点の無い地番だけ入れる)。未計測
    ('parcel',        'moj', 2, NULL, NULL),
    ('rsdt',          'abr', 3, 47,   DATE '2026-11-01'),
    -- abr の親番は枝番の地番の点の平均。未計測なので、計測済みの位置参照情報の親番の後に置く
    ('parcel_parent', 'isj', 4, 37,   DATE '2026-11-01'),
    ('parcel_parent', 'abr', 5, NULL, NULL),
    ('block',         'abr', 6, 76,   DATE '2026-11-01'),
    ('block',         'isj', 7, NULL, NULL)
) AS t(point_type, source, rank, error_m, measured_on)
ORDER BY rank
