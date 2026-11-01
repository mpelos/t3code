import { useAtomValue } from "@effect/atom-react";
import {
  type EditaiiConnectionState,
  type EnvironmentId,
  editaiiProblemMessage,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { editaiiEnvironment } from "../../state/editaii";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function EditaiiSettings() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("editaii")}>
        {environment ? (
          <EnvironmentConnection
            key={environment.environmentId}
            environmentId={environment.environmentId}
            label={environment.label}
          />
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Choose an environment to connect it to Editaii.
          </p>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnvironmentConnection({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(editaiiEnvironment.state({ environmentId, input: {} }));
  const state = AsyncResult.getOrElse(result, () => null);
  if (!state)
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        {AsyncResult.isFailure(result)
          ? "Could not read this environment's Editaii connection. Reconnect the environment or update T3."
          : "Loading Editaii connection…"}
      </p>
    );
  return (
    <ConnectionForm key={state.origin} environmentId={environmentId} label={label} state={state} />
  );
}

function ConnectionForm({
  environmentId,
  label,
  state,
}: {
  environmentId: EnvironmentId;
  label: string;
  state: EditaiiConnectionState;
}) {
  const [origin, setOrigin] = useState(state.origin ?? "");
  const [machineName, setMachineName] = useState(label);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allowed = useAtomValue(editaiiEnvironment.configure.permissionAtom(environmentId));
  const configure = useAtomCommand(editaiiEnvironment.configure, { reportFailure: false });
  const start = useAtomCommand(editaiiEnvironment.startPairing, { reportFailure: false });
  const reopen = useAtomCommand(editaiiEnvironment.reopenBrowser, { reportFailure: false });
  const disconnect = useAtomCommand(editaiiEnvironment.disconnect, { reportFailure: false });
  const disabled = pending || !allowed;
  const disconnected = state.status === "disconnected";

  async function run(operation: "configure" | "start" | "reopen" | "disconnect") {
    setPending(true);
    setError(null);
    const result =
      operation === "configure"
        ? await configure({ environmentId, input: { origin } })
        : operation === "start"
          ? await start({ environmentId, input: { machineName } })
          : operation === "reopen"
            ? await reopen({ environmentId, input: {} })
            : await disconnect({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not update the Editaii connection.",
      );
    }
  }

  return (
    <div className="grid gap-5 px-4 py-3">
      <p className="text-sm text-muted-foreground">
        Pairing opens the browser on <strong>{label}</strong>, the computer running this T3
        environment. Complete the Editaii sign-in and confirmation on that computer, even when you
        are using T3 remotely.
      </p>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("configure");
        }}
      >
        <label className="text-sm font-medium" htmlFor="editaii-origin">
          Editaii origin
        </label>
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1">
            <Input
              id="editaii-origin"
              type="url"
              value={origin}
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="https://editaii.example.com"
              autoCapitalize="none"
              spellCheck={false}
              disabled={disabled || !disconnected}
              required
            />
          </div>
          <Button
            type="submit"
            variant="outline"
            disabled={disabled || !disconnected || !origin.trim() || origin.trim() === state.origin}
          >
            Save origin
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The origin can only be changed while disconnected.{" "}
          {state.origin ? `Saved origin: ${state.origin}` : "Save the origin before pairing."}
        </p>
      </form>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run("start");
        }}
      >
        <label className="text-sm font-medium" htmlFor="editaii-machine-name">
          Machine name in Editaii
        </label>
        <Input
          id="editaii-machine-name"
          value={machineName}
          onChange={(event) => setMachineName(event.target.value)}
          maxLength={80}
          disabled={disabled || !disconnected}
          required
        />
        <div>
          <Button
            type="submit"
            disabled={
              disabled ||
              !disconnected ||
              !state.origin ||
              !machineName.trim() ||
              origin.trim() !== state.origin
            }
          >
            Connect to Editaii
          </Button>
        </div>
      </form>
      <div className="grid gap-2" role="status" aria-live="polite">
        <p className="text-sm font-medium">
          {state.status === "connected"
            ? "Connected to Editaii"
            : state.status === "pairing"
              ? "Waiting for the browser confirmation"
              : state.status === "redeeming"
                ? "Completing pairing…"
                : state.status === "error"
                  ? "Connection needs attention"
                  : "Disconnected"}
        </p>
        {state.machine && (
          <p className="text-sm text-muted-foreground">
            {state.machine.nome} · {state.machine.dono}
          </p>
        )}
        {state.problem && (
          <p className="text-sm text-destructive">{editaiiProblemMessage(state.problem)}</p>
        )}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {state.canReopen && (
          <Button variant="outline" disabled={disabled} onClick={() => void run("reopen")}>
            Open browser again
          </Button>
        )}
        {!disconnected && (
          <Button variant="outline" disabled={disabled} onClick={() => void run("disconnect")}>
            Disconnect
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Disconnecting removes this environment's local credentials. It does not revoke the machine
        in Editaii; revoke it there if you want to remove its access.
      </p>
    </div>
  );
}
