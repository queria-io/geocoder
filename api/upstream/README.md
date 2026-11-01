# upstream: abr-geocoder の取り込み

住所の正規化はデジタル庁の [abr-geocoder](https://github.com/digital-go-jp/abr-geocoder)
(MIT、`LICENSE`) を写している。上流が直したら、こちらも同じように直せるようにしておくための場所。

- `UPSTREAM`: 写した元のコミット
- `cases.json`: 上流の表形式の試験を抜き出したもの (`extract/main.go`)。正規化 (`normalize/`)・
  変換 (`transform/`)・issue ごとの名寄せの試験 (`matching/issues/`) が入る
- `sync.sh`: 上流を取り直して `cases.json` を作り直し、前回の `UPSTREAM` から変わったところを出す

## 写し方

- `src/normalize/`・`src/transform/` は `abrg/internal/normalize/`・`abrg/internal/transform/` と同じファイル名・同じ規則の名前・同じ順番にする。`src/char/`・`src/util/` は transform が使う分だけ写す。
  上流のファイルが変わったら、同じ名前のファイルを直せば済む
- `src/transform/special_chars.tsv` は上流の表をそのまま置く (`sync.sh` が写す)
- 試験は `test/upstream-normalize.test.ts` が `cases.json` をそのまま流す。こちらで試験を書き直さない
- 名寄せ (`matching/`) は上流の辞書 (DuckDB) に依るので写さない。issue の試験を正引きの試験として使う

## 上流を取り込む

```bash
upstream/sync.sh
pnpm test
```
