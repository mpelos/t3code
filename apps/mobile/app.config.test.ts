import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

const decodeConfig = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

it.each([false, true])("resolves iOS signing and capabilities for Personal Team=%s", (personal) => {
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { createRequire } from "node:module";
       const require = createRequire(${JSON.stringify(new URL("./package.json", import.meta.url).href)});
       const { getConfig } = require("expo/config");
       const { compileModsAsync } = require("expo/config-plugins");
       const projectRoot = ${JSON.stringify(NodeURL.fileURLToPath(new URL(".", import.meta.url)))};
       const { exp } = getConfig(projectRoot, { isModdedConfig: true });
       const config = await compileModsAsync(exp, {
         projectRoot, platforms: ["ios"], introspect: true, ignoreExistingNativeFiles: true,
       });
       console.log(JSON.stringify({
         ios: config.ios, entitlements: config._internal.modResults.ios.entitlements,
       }));`,
    ],
    {
      encoding: "utf8",
      cwd: NodeURL.fileURLToPath(new URL(".", import.meta.url)),
      env: {
        ...process.env,
        APP_VARIANT: "development",
        T3CODE_IOS_PERSONAL_TEAM: personal ? "1" : "0",
        T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.personal.t3code",
      },
    },
  );
  const config = decodeConfig(output.trim().split("\n").at(-1) ?? "");
  if (personal) {
    expect(config).toMatchObject({ ios: { bundleIdentifier: "com.example.personal.t3code" } });
    expect(config).not.toHaveProperty("ios.appleTeamId");
    expect(config).not.toHaveProperty("ios.associatedDomains");
    expect(config).not.toHaveProperty("ios.entitlements.keychain-access-groups");
    expect(config).not.toHaveProperty("entitlements.aps-environment");
    expect(config).not.toHaveProperty(["entitlements", "com.apple.developer.applesignin"]);
    expect(config).not.toHaveProperty(["entitlements", "com.apple.security.application-groups"]);
  } else {
    expect(config).toMatchObject({
      ios: {
        bundleIdentifier: "com.t3tools.t3code.dev",
        appleTeamId: "ARK85ZXQ4Z",
        associatedDomains: ["applinks:clerk.t3.codes", "webcredentials:clerk.t3.codes"],
        entitlements: {
          "keychain-access-groups": ["$(AppIdentifierPrefix)com.t3tools.t3code.dev"],
        },
      },
      entitlements: { "aps-environment": "development" },
    });
  }
});
