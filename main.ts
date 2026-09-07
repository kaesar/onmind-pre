#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { load as parseYaml } from "js-yaml";
import { logError, logWarning, logSuccess, logInfo } from "./trace.ts";
import {
  type Variable,
  parseSets,
  resolveValueFrom,
} from "./value.ts";
import { type Parameter, resolveParameters } from "./params.ts";
import {
  type Step,
  type Params,
  type RunStatus,
  exists,
  runShell,
  substituteVariables,
  runCheckoutStep,
  runCopyStep,
  runDeleteStep,
  runFetchStep,
  runTemplateStep,
  evaluateCondition,
} from "./step.ts";

// Re-exported so existing importers keep working.
export { isAskCommand, tokenizeAskArgs } from "./value.ts";
export { parseSets, parseDotenv, resolveValueFrom, type Variable } from "./value.ts";
export { substituteVariables, deriveRepoDir, evaluateCondition, runFetchStep } from "./step.ts";
export { selectJsonPath } from "./value.ts";

interface Config {
  parameters?: Parameter[];
  variables: Variable[];
  steps: Step[];
}

interface ConfigResult {
  params: Params;
  steps: Step[];
  continueOnError: boolean;
}

let hasValueFrom = false;

async function loadParameters(): Promise<ConfigResult> {
  let configPath: string | undefined;

  // 1. Check if config is provided as an argument
  const { values: args } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      "continue-on-error": { type: "boolean", default: false },
      set: { type: "string", multiple: true },
    },
    allowPositionals: true,
  });
  const continueOnError = !!args["continue-on-error"];
  const cliSets = parseSets(args.set);
  if (args.config) {
    configPath = args.config;
    if (await exists(configPath)) {
      console.log(`Using configuration from argument: ${configPath}`);
    } else {
      logError(`Error: Configuration file specified in arguments not found: ${configPath}`);
      process.exit(1);
    }
  }

  // 2. Check ./_pre.yml if no argument provided
  if (!configPath && (await exists("./_pre.yml"))) {
    configPath = "./_pre.yml";
    console.log("Using configuration from ./_pre.yml");
  }

  // 3. Check ./pre/_pre.yml if previous locations not found
  if (!configPath && (await exists("./pre/_pre.yml"))) {
    configPath = "./pre/_pre.yml";
    console.log("Using configuration from ./pre/_pre.yml");
  }

  // 4. Error if no configuration file found
  if (!configPath) {
    logWarning("Error: No configuration file found. Please provide one of the following:");
    logWarning("- Use --config argument to specify the configuration file");
    logWarning("- Place _pre.yml in the current directory");
    logWarning("- Place _pre.yml in the ./pre directory");
    process.exit(1);
  }

  const configText = await readFile(configPath as string, "utf-8");
  const config = parseYaml(configText) as Config;
  if (!config.variables || !Array.isArray(config.variables)) {
    logError("El archivo YAML debe contener una lista 'variables'.");
    process.exit(1);
  }
  if (!config.steps || !Array.isArray(config.steps)) {
    logError("El archivo YAML debe contener una lista 'steps'.");
    process.exit(1);
  }

  const params: Params = {};
  // Input contract first: parameters seed the run and are validated upfront.
  try {
    Object.assign(params, await resolveParameters(config.parameters, cliSets));
  } catch (error: unknown) {
    logError(`Invalid parameters declaration: ${(error as Error).message}`);
    process.exit(1);
  }
  // Sequential resolution: interactive `ask ...` prompts would overlap if run in parallel.
  for (const variable of config.variables ?? []) {
    if (variable.name in params) {
      logError(`Variable "${variable.name}" duplicates a parameter.`);
      process.exit(1);
    }
    try {
      params[variable.name] = await resolveValueFrom(variable, cliSets, params);
    } catch (error: unknown) {
      logError(`Error resolving variable "${variable.name}": ${(error as Error).message}`);
      process.exit(1);
    }
    if (variable.valueFrom !== undefined) hasValueFrom = true;
  }
  const known = new Set([
    ...(config.parameters ?? []).map((q) => q.name),
    ...(config.variables ?? []).map((v) => v.name),
  ]);
  const unknown = Object.keys(cliSets).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    logWarning(`Warning: --set ${unknown.join(", ")} matches no parameter or variable.`);
  }

  return { params, steps: config.steps, continueOnError };
}

async function executeSteps(steps: Step[], params: Params, continueOnError: boolean) {
  const status: RunStatus = { failed: false };
  // Agrupar pasos paralelos y secuenciales
  let i = 0;
  while (i < steps.length) {
    if (steps[i].parallel) {
      // Ejecutar todos los pasos consecutivos con parallel: true
      const parallelGroup = [];
      while (i < steps.length && steps[i].parallel) {
        parallelGroup.push(steps[i]);
        i++;
      }
      await Promise.all(parallelGroup.map(async (step) => {
        await runStep(step, params, continueOnError, status);
      }));
    } else {
      await runStep(steps[i], params, continueOnError, status);
      i++;
    }
  }
  // Azure semantics: the run fails if any step failed without continueOnError,
  // even when failed()/always() steps ran afterwards.
  if (status.failed) {
    logError(":: [ Completed with failures ] ::");
    process.exit(1);
  }
  logSuccess(":: [ Prepared sentences completed successfully ] ::");
}

async function runStep(step: Step, params: Params, continueOnError: boolean, status: RunStatus) {
  if (step.displayName) {
    logInfo(`\n:: [ ${step.displayName} ] ::`);
  }
  // Homologado Azure Pipelines: continueOnError por step, con fallback al flag global.
  const effectiveContinueOnError = step.continueOnError ?? continueOnError;
  // Default condition is succeeded(): after a failure only steps opting into
  // failed()/always()/succeededOrFailed() still run.
  const condSrc = step.condition ?? "succeeded()";
  try {
    let run: boolean;
    try {
      run = evaluateCondition(condSrc, params, status);
    } catch (error: unknown) {
      throw new Error(`Invalid condition "${condSrc}": ${(error as Error).message}`);
    }
    if (!run) {
      logInfo(`Skipped (condition "${condSrc}" is false).`);
      return;
    }
    const kinds = [step.bash, step.checkout, step.copy, step.delete, step.fetch, step.template].filter(
      (k) => k !== undefined,
    ).length;
    if (kinds !== 1) {
      throw new Error(
        "Step must define exactly one of 'bash', 'checkout', 'copy', 'delete', 'fetch' or 'template'.",
      );
    }
    if (step.checkout !== undefined) {
      await runCheckoutStep(step, params);
      return;
    }
    if (step.copy !== undefined) {
      await runCopyStep(step, params);
      return;
    }
    if (step.delete !== undefined) {
      await runDeleteStep(step, params);
      return;
    }
    if (step.fetch !== undefined) {
      await runFetchStep(step, params);
      return;
    }
    if (step.template !== undefined) {
      await runTemplateStep(step, params);
      return;
    }
    await runBashStep(step, params);
  } catch (error: unknown) {
    const message = (error as Error).message;
    // Authoring bugs fail fast with a clear message.
    if (message.startsWith("Invalid condition") || message.startsWith("Step must define")) {
      logError(`\n * ${message}\n`);
      process.exit(1);
    }
    // Execution failures set the run status instead of exiting, so
    // failed()/always() steps still run; the exit code is decided at the end.
    logError(`\n * Error executing step${step.displayName ? ` "${step.displayName}"` : ""}\n`);
    if (!effectiveContinueOnError) {
      status.failed = true;
    }
  }
}

async function runBashStep(step: Step, params: Params) {
  const command = substituteVariables(step.bash as string, params);
  logWarning(`=> ${command}`);
  const result = await runShell(command);
  logSuccess(` √ ${result.trimEnd()}`);
}

async function main() {
  const { params, steps, continueOnError } = await loadParameters();
  console.log(`\n=> Loaded parameters:`, params);
  await executeSteps(steps, params, continueOnError);
}

if (import.meta.main) {
  main();
}
