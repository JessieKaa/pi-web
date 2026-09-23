import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler, POST as POSTHandler, PUT as PUTHandler } from "@/app/api/models/scope/route";

export const Route = createFileRoute("/api/models/scope")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
      PUT: ({ request }) => PUTHandler(request),
      POST: ({ request }) => POSTHandler(request),
    },
  },
});
