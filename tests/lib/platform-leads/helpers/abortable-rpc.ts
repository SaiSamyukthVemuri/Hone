// A fake `admin.rpc` that behaves like PostgREST's builder where the worker
// relies on it: lazy until awaited, and `.abortSignal(signal)` makes an
// aborted call answer with an error (postgrest-js never throws for it).
type RpcAnswer = { data: unknown; error: { code?: string; message?: string } | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each fake declares its own rpc arguments
export function abortableRpc<A extends any[]>(impl: (...args: A) => unknown) {
  return (...args: A) => {
    let signal: AbortSignal | null = null;
    const run = (): Promise<RpcAnswer> => {
      const answer = Promise.resolve().then(() => impl(...args) as RpcAnswer);
      if (!signal) return answer;
      const s = signal;
      const aborted = new Promise<RpcAnswer>((resolve) => {
        const onAbort = () => resolve({ data: null, error: { code: "", message: "AbortError: This operation was aborted" } });
        if (s.aborted) onAbort();
        else s.addEventListener("abort", onAbort, { once: true });
      });
      return Promise.race([answer, aborted]);
    };
    const builder = {
      abortSignal(s: AbortSignal) {
        signal = s;
        return builder;
      },
      then<T1 = RpcAnswer, T2 = never>(
        onFulfilled?: ((v: RpcAnswer) => T1 | PromiseLike<T1>) | null,
        onRejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null,
      ): Promise<T1 | T2> {
        return run().then(onFulfilled, onRejected);
      },
    };
    return builder;
  };
}
