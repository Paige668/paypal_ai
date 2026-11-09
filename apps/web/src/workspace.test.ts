import { describe, expect, it, vi } from "vitest";
import { clearCurrentOrderId, CURRENT_ORDER_KEY, readCurrentOrderId, storeCurrentOrderId } from "./workspace";

function storage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => { value = next; }),
    removeItem: vi.fn(() => { value = null; })
  };
}

describe("current workspace persistence", () => {
  it("stores and restores only internal merchant order IDs", () => {
    const target = storage();
    storeCurrentOrderId(target, "ord_demo");
    expect(target.setItem).toHaveBeenCalledWith(CURRENT_ORDER_KEY, "ord_demo");
    expect(readCurrentOrderId(target)).toBe("ord_demo");

    storeCurrentOrderId(target, "PAYPAL-ORDER");
    expect(target.setItem).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed or unavailable browser storage", () => {
    expect(readCurrentOrderId(storage("unexpected"))).toBeNull();
    const unavailable = {
      getItem: vi.fn(() => { throw new Error("blocked"); }),
      setItem: vi.fn(() => { throw new Error("blocked"); }),
      removeItem: vi.fn(() => { throw new Error("blocked"); })
    };
    expect(readCurrentOrderId(unavailable)).toBeNull();
    expect(() => storeCurrentOrderId(unavailable, "ord_demo")).not.toThrow();
    expect(() => clearCurrentOrderId(unavailable)).not.toThrow();
  });
});
