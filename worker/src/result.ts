// 失敗しうる処理を値で返す。try-catch を呼び出し側に書かない
export type Result<T, E = unknown> = { ok: true; value: T } | { ok: false; error: E };

export const tryCatchAsync = async <T>(f: () => Promise<T>): Promise<Result<T>> => {
  try {
    return { ok: true, value: await f() };
  } catch (error) {
    return { ok: false, error };
  }
};
