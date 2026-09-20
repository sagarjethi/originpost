import "dotenv/config";
import { loadInstallationSettings } from "@originpost/db";

// Worker providers capture configuration during module initialization.
loadInstallationSettings();
await import("./worker.js");
