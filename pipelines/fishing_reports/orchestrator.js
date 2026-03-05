import { runOrchestratorFromCli } from "./orchestratorCore.js";

runOrchestratorFromCli().catch((error) => {
  console.error(`[orchestrator] failed: ${error.message}`);
  process.exitCode = 1;
});
