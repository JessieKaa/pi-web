import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler, PUT as PUTHandler } from "@/app/api/cache-warming/route";

export const Route = createFileRoute("/api/cache-warming")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
      PUT: ({ request }) => PUTHandler(request),
    },
  },
});
