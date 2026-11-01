# Connect a machine to Editaii

In **Settings → Editaii**, choose the T3 environment you want to connect. Save the
HTTPS origin of your Editaii installation and give the machine a name.

Connecting opens the browser on the computer running that environment. Sign in
to Editaii there and confirm the machine. This is also where you finish when you
started from a remote T3 client. You can reopen the same browser attempt for ten
minutes.

T3 keeps the machine's credentials on that environment. If pairing was already
received when T3 stopped, it resumes the registration and activation on startup.
An attempt still waiting for its browser callback must be started again.

Disconnecting removes the local credentials; it does not revoke the machine in
Editaii. Revoke it in Editaii to remove its access. Pairing is available in this
version; delivery of chat and other work is not implemented yet.
