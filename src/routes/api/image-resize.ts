import { createFileRoute } from "@tanstack/react-router";
import { GET as GETHandler, PUT as PUTHandler } from "@/app/api/image-resize/route";

export const Route = createFileRoute("/api/image-resize")({
  server: {
    handlers: {
      GET: ({ request }) => GETHandler(request),
      PUT: ({ request }) => PUTHandler(request),
    },
  },
});
