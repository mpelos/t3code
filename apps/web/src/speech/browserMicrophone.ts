export function openMicrophone(microphoneId: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<MediaStream>((resolve, reject) => {
    const onAbort = () => reject(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const open = () => {
      if (!microphoneId) return navigator.mediaDevices.getUserMedia({ audio: true });
      return navigator.mediaDevices
        .getUserMedia({
          audio: { deviceId: { exact: microphoneId } },
        })
        .catch((error: unknown) => {
          signal?.throwIfAborted();
          const name =
            typeof error === "object" && error !== null && "name" in error ? error.name : "";
          if (name !== "OverconstrainedError" && name !== "NotFoundError") throw error;
          return navigator.mediaDevices.getUserMedia({ audio: true });
        });
    };
    const desktop = window.desktopBridge;
    const permission =
      desktop?.getClientPlatform() === "darwin"
        ? desktop.requestMicrophoneAccess().then((granted) => {
            signal?.throwIfAborted();
            if (!granted)
              throw new DOMException("Microphone access was denied by macOS.", "NotAllowedError");
            return open();
          })
        : open();
    void permission.then(
      (media) => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) media.getTracks().forEach((track) => track.stop());
        else resolve(media);
      },
      (error: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
