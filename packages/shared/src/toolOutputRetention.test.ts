import { expect, it } from "@effect/vitest";
import { retainToolOutput } from "./toolOutputRetention.ts";
const now = "2026-10-14T00:00:00.000Z";

it("bounds UTF-8 command output and explicitly records permanent retention", () => {
  const item = {
    type: "command_execution",
    status: "completed",
    input: "echo hello",
    exitCode: 0,
    output: "α".repeat(12000),
  };
  const retained = retainToolOutput(item, now);
  expect(Buffer.byteLength(retained.output)).toBeLessThanOrEqual(8192);
  expect(retained.output).not.toContain("�");
  expect(retained.output).toContain("full output was removed");
  expect(retained.input).toBe(item.input);
  expect("outputRetention" in retained).toBe(true);
  expect("outputOmitted" in retained).toBe(false);
});

it("preserves structured references, flags and shape while shortening text", () => {
  const output = {
    taskId: "task",
    structuredContent: { taskId: "task", status: "done" },
    isError: false,
    content: [
      { type: "text", text: "x".repeat(20000) },
      { type: "resource_link", uri: "app://widget", name: "widget" },
    ],
  };
  const retained = retainToolOutput({ type: "dynamic_tool", status: "completed", output }, now);
  expect(retained.output.taskId).toBe("task");
  expect(retained.output.structuredContent).toEqual(output.structuredContent);
  expect(retained.output.isError).toBe(false);
  expect(retained.output.content[1]).toEqual(output.content[1]);
  expect(retained.output.content[0]!.text!.length).toBeLessThan(8193);
});

it("leaves failed, unfinished, withheld and error-bearing outputs intact", () => {
  for (const status of ["failed", "running", "pending", "cancelled", "interrupted"]) {
    const item = { type: "command_execution", status, output: "x".repeat(20000) };
    expect(retainToolOutput(item, now)).toBe(item);
  }
  const error = {
    type: "dynamic_tool",
    status: "completed",
    output: { isError: true, content: [{ type: "text", text: "x".repeat(20000) }] },
  };
  expect(retainToolOutput(error, now)).toBe(error);
  const omitted = {
    type: "dynamic_tool",
    status: "completed",
    output: "x".repeat(20000),
    outputOmitted: true,
  };
  expect(retainToolOutput(omitted, now)).toBe(omitted);
});

it("keeps unsuccessful command outputs even when their item status says completed", () => {
  for (const flags of [{ exitCode: 1 }, { exitCode: -1 }, { outputIndicatesFailure: true }]) {
    const item = {
      type: "command_execution",
      status: "completed",
      output: "x".repeat(20000),
      ...flags,
    };
    expect(retainToolOutput(item, now)).toBe(item);
  }
});
