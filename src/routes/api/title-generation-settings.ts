import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler, PUT as PUTHandler } from "@/app/api/title-generation-settings/route";

export const Route = createFileRoute("/api/title-generation-settings")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
      PUT: ({ request }) => PUTHandler(request),
    },
  },
});
