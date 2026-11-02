/**
 * The Editaii as the T3 server mounts it: the link (EditaiiConnection), the connector that carries
 * its work to this T3 once the server is active, and the panel that shows both (EditaiiPainel).
 * The journal opens on first use, so one that cannot be opened stops the connector, not the T3.
 */
import * as Layer from "effect/Layer";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Configuracao from "./EditaiiConfiguracao.ts";
import * as Connection from "./EditaiiConnection.ts";
import * as Connector from "./EditaiiConnector.ts";
import * as Journal from "./EditaiiJournal.ts";
import * as Painel from "./EditaiiPainel.ts";
import * as Adapter from "./EditaiiT3Adapter.ts";

export const layer = Painel.layer.pipe(
  Layer.provide(Connector.layer(Configuracao.ler)),
  Layer.provide(
    Layer.merge(
      Journal.layer,
      Adapter.layer.pipe(Layer.provide(CommandReceiptStore.layerFromApplicationReceipts)),
    ),
  ),
  Layer.provideMerge(Connection.layer),
);
