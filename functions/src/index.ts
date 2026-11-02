import cors from "cors";
import express from "express";
import { initializeApp } from "firebase-admin/app";
import { setGlobalOptions } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { ANTHROPIC_API_KEY, APP_URL, GEMINI_API_KEY, HL_CLIENT_SECRET } from "./config";
import { createSessionHandler, deleteSessionHandler } from "./lib/auth";
import { asyncRoute, errorMiddleware } from "./lib/errors";
import { cancelHandler, generateHandler } from "./routes/generate";
import { authorizeUrlHandler, callHandler, completeOauthHandler, disconnectHandler, oauthCallbackHandler } from "./routes/hl";
import { restoreHandler } from "./routes/snapshots";

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const app = express();
app.use(
  cors({
    origin: (origin, cb) => {
      // Allow the deployed app, its Firebase alias domain, and local dev servers.
      const allowed = [APP_URL.value(), APP_URL.value().replace(".web.app", ".firebaseapp.com")];
      if (!origin || allowed.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) cb(null, true);
      else cb(null, false);
    },
  }),
);
app.use(express.json({ limit: "256kb" }));

const routes = express.Router();
routes.get("/health", (_req, res) => {
  res.json({ ok: true });
});
routes.post("/session", asyncRoute(createSessionHandler));
routes.post("/session/logout", asyncRoute(deleteSessionHandler));
routes.get("/hl/authorize-url", asyncRoute(authorizeUrlHandler));
routes.get("/oauth/callback", asyncRoute(oauthCallbackHandler));
routes.post("/hl/complete", asyncRoute(completeOauthHandler));
routes.post("/hl/disconnect", asyncRoute(disconnectHandler));
routes.post("/hl/call", asyncRoute(callHandler));
routes.post("/generate", asyncRoute(generateHandler));
routes.post("/generate/cancel", asyncRoute(cancelHandler));
routes.post("/projects/:projectId/snapshots/:snapshotId/restore", asyncRoute(restoreHandler));
// Same routes under /api for same-origin calls through the Hosting rewrite (cookie-authenticated
// /hl/call and /session need first-party cookies; the direct function URL is cross-site).
app.use(routes);
app.use("/api", routes);
app.use(errorMiddleware);

/** One 2nd-gen function (Cloud Run, so responses can stream): one cold start, one OAuth redirect URL. */
export const api = onRequest(
  {
    timeoutSeconds: 540,
    memory: "512MiB",
    concurrency: 40,
    secrets: [ANTHROPIC_API_KEY, HL_CLIENT_SECRET, GEMINI_API_KEY],
    invoker: "public",
  },
  app,
);
