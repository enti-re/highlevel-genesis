import { defineInt, defineSecret, defineString } from "firebase-functions/params";

// Secrets live in Secret Manager in production and functions/.secret.local in the emulator.
export const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
export const HL_CLIENT_SECRET = defineSecret("HL_CLIENT_SECRET");
export const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

// Plain config lives in functions/.env (see .env.example at the repo root).
export const HL_CLIENT_ID = defineString("HL_CLIENT_ID");
export const API_BASE_URL = defineString("API_BASE_URL");
export const APP_URL = defineString("APP_URL", { default: "http://localhost:5173" });
export const LLM_MODEL = defineString("LLM_MODEL", { default: "claude-opus-5-5" });
/** "anthropic" (default) or "gemini" (opt-in, for testing without Claude credits). */
export const LLM_PROVIDER = defineString("LLM_PROVIDER", { default: "anthropic" });
/** Local development only: canned LLM stream / fake HighLevel data, no external calls. */
export const MOCK_LLM = defineString("MOCK_LLM", { default: "false" });
export const MOCK_HL = defineString("MOCK_HL", { default: "false" });

export const isMockLlm = () => MOCK_LLM.value() === "true";
export const isMockHl = () => MOCK_HL.value() === "true";
export const oauthRedirectUri = () => `${API_BASE_URL.value().replace(/\/$/, "")}/oauth/callback`;

/** Warm instances kept running. 1 while the app is under review avoids a cold start on the first request; 0 otherwise. */
export const MIN_INSTANCES = defineInt("MIN_INSTANCES", { default: 0 });
