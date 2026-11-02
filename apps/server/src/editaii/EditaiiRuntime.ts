/**
 * The Editaii as the T3 server mounts it: the link to the Editaii (EditaiiConnection) and the
 * connector that carries the link's work to this T3 once the server is active. A new conversation
 * runs as EditaiiConfiguracao reads it from the T3; the journal opens on first use, so a journal
 * that cannot be opened stops the connector and not the T3.
 */
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Configuracao from "./EditaiiConfiguracao.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Connector from "./EditaiiConnector.ts";
import * as Journal from "./EditaiiJournal.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";

export const layer = Connector.layer(Configuracao.ler).pipe(
  Layer.provide(
    Layer.merge(
      Journal.layer,
      Adapter.layer.pipe(Layer.provide(CommandReceiptStore.layerFromApplicationReceipts)),
    ),
  ),
  Layer.provideMerge(Connection.layer),
);
