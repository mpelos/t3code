import { expect, it, vi } from "vite-plus/test";
import { openMicrophone } from "./browserMicrophone";

function installMacBridge(requestMicrophoneAccess: () => Promise<boolean>) {
  const original = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { getClientPlatform: () => "darwin", requestMicrophoneAccess },
  });
  return {
    [Symbol.dispose]() {
      if (original) Object.defineProperty(window, "desktopBridge", original);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
}

it("cancels an unanswered permission prompt and stops a late microphone stream", async () => {
  const permission = Promise.withResolvers<MediaStream>();
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockReturnValue(permission.promise);
  const abort = new AbortController();
  const rejected = vi.fn();
  const preparing = openMicrophone("", abort.signal).catch(rejected);
  expect(microphone).toHaveBeenCalledOnce();
  abort.abort();
  const context = new AudioContext();
  const media = context.createMediaStreamDestination().stream;
  const track = media.getAudioTracks()[0];
  if (!track) throw new Error("The test audio stream has no track.");
  using stop = vi.spyOn(track, "stop");
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    permission.resolve(media);
    await preparing;
    await context.close();
  }
  expect(stop).toHaveBeenCalledOnce();
});

it("waits for native macOS access before opening the microphone and cancels a pending request", async () => {
  const native = Promise.withResolvers<boolean>();
  const requestMicrophoneAccess = vi.fn(() => native.promise);
  using _bridge = installMacBridge(requestMicrophoneAccess);
  const media = Promise.withResolvers<MediaStream>();
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockReturnValue(media.promise);
  const abort = new AbortController();
  const preparing = openMicrophone("", abort.signal);
  try {
    expect(requestMicrophoneAccess).toHaveBeenCalledOnce();
    expect(microphone).not.toHaveBeenCalled();
  } finally {
    abort.abort();
    native.resolve(true);
    media.resolve(new MediaStream());
    await expect(preparing).rejects.toBe(abort.signal.reason);
  }
  expect(microphone).not.toHaveBeenCalled();
});

it.each(["", "external-microphone"])(
  "opens %j only after native permission is granted",
  async (microphoneId) => {
    const native = Promise.withResolvers<boolean>();
    using _bridge = installMacBridge(() => native.promise);
    const media = new MediaStream();
    using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(media);
    const opening = openMicrophone(microphoneId);
    expect(microphone).not.toHaveBeenCalled();
    native.resolve(true);
    expect(await opening).toBe(media);
    expect(microphone).toHaveBeenCalledExactlyOnceWith({
      audio: microphoneId ? { deviceId: { exact: microphoneId } } : true,
    });
  },
);

it.each(["denied", "failed"])("does not capture when native access is %s", async (outcome) => {
  const failure = new Error("macOS permission request failed");
  using _bridge = installMacBridge(() =>
    outcome === "denied" ? Promise.resolve(false) : Promise.reject(failure),
  );
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia");
  const opening = openMicrophone("");
  if (outcome === "denied")
    await expect(opening).rejects.toMatchObject({ name: "NotAllowedError" });
  else await expect(opening).rejects.toBe(failure);
  expect(microphone).not.toHaveBeenCalled();
});

it("falls back to the system default when the saved microphone is gone, and reports other failures", async () => {
  const media = new MediaStream();
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValueOnce(media);
  await expect(openMicrophone("blue-yeti")).resolves.toBe(media);
  expect(microphone).toHaveBeenLastCalledWith({ audio: true });

  const denied = new DOMException("denied", "NotAllowedError");
  microphone.mockRejectedValueOnce(denied);
  await expect(openMicrophone("blue-yeti")).rejects.toBe(denied);
  expect(microphone).toHaveBeenCalledTimes(3);
});
