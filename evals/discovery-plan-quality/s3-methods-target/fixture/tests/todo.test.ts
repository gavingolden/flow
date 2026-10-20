import { expect, test } from "bun:test";
import { nextId, type Todo } from "../src/todo";

const t = (id: number): Todo => ({ id, title: `t${id}`, done: false, priority: "normal" });

test("nextId is one past the highest id", () => {
  expect(nextId([])).toBe(1);
  expect(nextId([t(1), t(4)])).toBe(5);
});
