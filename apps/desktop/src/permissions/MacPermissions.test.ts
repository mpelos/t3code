import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import { MacPermissions, layer } from "./MacPermissions.ts";

const native = vi.hoisted(() => ({
  status: vi.fn(),
  request: vi.fn(),
}));
vi.mock("electron", () => ({
  systemPreferences: {
    getMediaAccessStatus: native.status,
    askForMediaAccess: native.request,
  },
}));

describe("microphone access", () => {
  it.effect.each([
    { platform: "darwin", status: "granted", accepted: false, granted: true, prompts: 0 },
    { platform: "darwin", status: "not-determined", accepted: true, granted: true, prompts: 1 },
    { platform: "darwin", status: "not-determined", accepted: false, granted: false, prompts: 1 },
    { platform: "darwin", status: "denied", accepted: true, granted: false, prompts: 0 },
    { platform: "darwin", status: "restricted", accepted: true, granted: false, prompts: 0 },
    { platform: "darwin", status: "unknown", accepted: true, granted: false, prompts: 0 },
    { platform: "win32", status: "denied", accepted: false, granted: true, prompts: 0 },
    { platform: "linux", status: "denied", accepted: false, granted: true, prompts: 0 },
  ] as const)("resolves $platform/$status with acceptance $accepted", (input) => {
    native.status.mockReset().mockReturnValue(input.status);
    native.request.mockReset().mockResolvedValue(input.accepted);
    return Effect.gen(function* () {
      const permissions = yield* MacPermissions;
      expect(yield* permissions.checkMicrophoneAccess).toBe(
        input.platform !== "darwin" || input.status === "granted",
      );
      expect(yield* permissions.requestMicrophoneAccess()).toBe(input.granted);
      expect(native.request).toHaveBeenCalledTimes(input.prompts);
      if (input.prompts > 0) expect(native.request).toHaveBeenCalledWith("microphone");
      if (input.platform !== "darwin") expect(native.status).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            DesktopEnvironment.layer({
              platform: input.platform,
              dirname: "/repo/apps/desktop/dist-electron",
              homeDirectory: "/test-home",
              processArch: "arm64",
              appVersion: "0.1.5",
              appPath: "/repo",
              isPackaged: true,
              resourcesPath: "/repo/resources",
              runningUnderArm64Translation: false,
            }).pipe(Layer.provide(DesktopConfig.layerTest({}))),
          ),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  });
});
