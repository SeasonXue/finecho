import { describe, expect, it } from "bun:test";
import { pLimit } from "./concurrency.ts";

function defer<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("pLimit", () => {
  it("并发上限不会被超过", async () => {
    const limit = pLimit(2);
    let active = 0;
    let peak = 0;
    const tick = () => new Promise<void>((r) => setTimeout(r, 5));
    const tasks = Array.from({ length: 10 }, () =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await tick();
        active--;
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("按入队顺序启动任务", async () => {
    const limit = pLimit(1);
    const order: number[] = [];
    const gates = [defer<void>(), defer<void>(), defer<void>()];

    const p1 = limit(async () => {
      order.push(1);
      await gates[0]!.promise;
    });
    const p2 = limit(async () => {
      order.push(2);
      await gates[1]!.promise;
    });
    const p3 = limit(async () => {
      order.push(3);
      await gates[2]!.promise;
    });

    // 让事件循环跑一圈，让 p1 真正开始
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual([1]);

    gates[0]!.resolve();
    await p1;
    await Promise.resolve();
    expect(order).toEqual([1, 2]);

    gates[1]!.resolve();
    await p2;
    gates[2]!.resolve();
    await p3;
    expect(order).toEqual([1, 2, 3]);
  });

  it("任务异常不会卡住后续任务", async () => {
    const limit = pLimit(1);
    const ran: string[] = [];
    const failing = limit(async () => {
      ran.push("a");
      throw new Error("boom");
    });
    const ok = limit(async () => {
      ran.push("b");
      return 42;
    });
    await expect(failing).rejects.toThrow("boom");
    await expect(ok).resolves.toBe(42);
    expect(ran).toEqual(["a", "b"]);
  });

  it("传递返回值", async () => {
    const limit = pLimit(3);
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => limit(async () => n * 2)),
    );
    expect(results).toEqual([2, 4, 6, 8, 10]);
  });
});
