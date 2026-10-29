export const MAC_PERMISSION_SETTINGS_URLS = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  "screen-recording":
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

export type MacPermission = keyof typeof MAC_PERMISSION_SETTINGS_URLS;

export const MAC_PERMISSION_TITLES: Record<MacPermission, string> = {
  microphone: "Microphone",
  "screen-recording": "Screen Recording",
  accessibility: "Accessibility",
  "full-disk-access": "Full Disk Access",
};
