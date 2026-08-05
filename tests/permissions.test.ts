import { describe, expect, it } from "vitest";
import { approvalLevelFor } from "../src/policy/approval.js";
import { roleAllows } from "../src/policy/permissions.js";

describe("permission baseline", () => {
  it("does not let viewers execute shell commands", () => {
    expect(roleAllows("viewer", "shell.execute")).toBe(false);
  });

  it("requires local confirmation for system administration", () => {
    expect(approvalLevelFor("system.admin")).toBe("local-confirmation");
  });

  it("requires chat confirmation before deleting files", () => {
    expect(approvalLevelFor("files.delete")).toBe("chat-confirmation");
  });
});
