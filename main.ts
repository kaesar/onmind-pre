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
import {
  type Step,
  type Params,
  exists,
  runShell,
  substituteVariables,
  runCheckoutStep,
  runCopyStep,
  runDeleteStep,
  evaluateCondition,
} from "./step.ts";

// Re-exported so existing importers keep working.
export { isAskCommand, tokenizeAskArgs } from "./value.ts";
export { parseSets, parseDotenv, resolveValueFrom, type Variable } from "./value.ts";
export { substituteVariables, deriveRepoDir, evaluateCondition } from "./step.ts";

interface Config {
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
  // Sequential resolution: interactive `ask ...` prompts would overlap if run in parallel.
  for (const variable of config.variables ?? []) {
    try {
      params[variable.name] = await resolveValueFrom(variable, cliSets, params);
    } catch (error: unknown) {
      logError(`Error resolving variable "${variable.name}": ${(error as Error).message}`);
      process.exit(1);
    }
    if (variable.valueFrom !== undefined) hasValueFrom = true;
  }

  return { params, steps: config.steps, continueOnError };
}

async function executeSteps(steps: Step[], params: Params, continueOnError: boolean) {
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
        await runStep(step, params, continueOnError);
      }));
    } else {
      await runStep(steps[i], params, continueOnError);
      i++;
    }
  }
  logSuccess(":: [ Prepared sentences completed successfully ] ::");
}

async function runStep(step: Step, params: Params, continueOnError: boolean) {
  if (step.displayName) {
    logInfo(`\n:: [ ${step.displayName} ] ::`);
  }
  // Homologado Azure Pipelines: continueOnError por step, con fallback al flag global.
  const effectiveContinueOnError = step.continueOnError ?? continueOnError;
  try {
    if (step.condition !== undefined) {
      let run: boolean;
      try {
        run = evaluateCondition(step.condition, params);
      } catch (error: unknown) {
        throw new Error(`Invalid condition "${step.condition}": ${(error as Error).message}`);
      }
      if (!run) {
        logInfo(`Skipped (condition false): ${step.condition}`);
        return;
      }
    }
    const kinds = [step.bash, step.checkout, step.copy, step.delete].filter(
      (k) => k !== undefined,
    ).length;
    if (kinds !== 1) {
      throw new Error("Step must define exactly one of 'bash', 'checkout', 'copy' or 'delete'.");
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
    await runBashStep(step, params);
  } catch (error: unknown) {
    logError(`\n * Error executing step${step.displayName ? ` "${step.displayName}"` : ""}\n`);
    if (!effectiveContinueOnError) {
      process.exit(1);
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
