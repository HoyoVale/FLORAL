import { describe, expect, it, vi } from "vitest";
import { FloralArtifactToolController } from "../src/agent/floral-artifact-tools.js";

describe("FloralArtifactToolController", () => {
  it("normalizes a valid outbound registration before delegation", async () => {
    const registrationHandler = vi.fn(async () => ({
      status: "registered" as const,
      artifactId: "artifact-1",
    }));
    const result = await new FloralArtifactToolController().handle({
      tool: "register_outbound_file",
      arguments: {
        local_path: "C:\\workspace\\artifacts\\outbound\\report.txt",
        file_name: "report.txt",
        caption: "  build   report  ",
      },
      registrationHandler,
    });

    expect(result).toEqual({
      success: true,
      text: "artifact_registration=registered\nartifactId=artifact-1",
    });
    expect(registrationHandler).toHaveBeenCalledWith({
      localPath: "C:\\workspace\\artifacts\\outbound\\report.txt",
      fileName: "report.txt",
      caption: "build report",
    });
  });

  it("rejects path-bearing file names before invoking the host", async () => {
    const registrationHandler = vi.fn();
    const result = await new FloralArtifactToolController().handle({
      tool: "register_outbound_file",
      arguments: {
        local_path: "/workspace/artifacts/outbound/report.txt",
        file_name: "../report.txt",
      },
      registrationHandler,
    });

    expect(result).toEqual({
      success: false,
      text: "artifact_registration=denied\nreason=handler-or-arguments",
    });
    expect(registrationHandler).not.toHaveBeenCalled();
  });

  it("rejects arbitrary delivery identifiers before invoking the host", async () => {
    const deliveryHandler = vi.fn();
    const result = await new FloralArtifactToolController().handle({
      tool: "send_artifact",
      arguments: { artifact_id: "../../secret" },
      deliveryHandler,
    });

    expect(result).toEqual({
      success: false,
      text: "artifact_delivery=denied\nreason=handler-or-arguments",
    });
    expect(deliveryHandler).not.toHaveBeenCalled();
  });

  it("fails closed and sanitizes a delivery handler error", async () => {
    const result = await new FloralArtifactToolController().handle({
      tool: "send_artifact",
      arguments: { artifact_id: "artifact-1" },
      deliveryHandler: async () => {
        throw new Error("transport secret");
      },
    });

    expect(result).toEqual({
      success: false,
      text: [
        "artifact_delivery=failed",
        "artifactId=artifact-1",
        "reason=delivery-handler-error",
      ].join("\n"),
    });
  });
});
