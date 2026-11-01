import { createFileRoute } from "@tanstack/react-router";
import { EditaiiSettings } from "../components/settings/EditaiiSettings";

export const Route = createFileRoute("/_chat/settings/editaii")({ component: EditaiiSettings });
